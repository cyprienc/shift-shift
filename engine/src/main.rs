#![forbid(unsafe_code)]
mod symbols;
use globset::{Glob, GlobSet, GlobSetBuilder};
use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};
use rayon::prelude::*;
use redb::{Database, ReadableDatabase, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BinaryHeap, HashMap},
    fs,
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};
use walkdir::WalkDir;

const TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("files");
const DEFAULT_EXCLUDES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".claude",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    "target",
    "build",
    "dist",
    ".cache",
    "site-packages",
];
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub name: String,
    pub qualified: String,
    pub kind: String,
    pub line: u32,
    pub column: u32,
}
#[derive(Clone)]
enum Storage {
    Ram(Arc<Vec<Record>>),
    Disk,
}
#[derive(Clone)]
struct Entry {
    storage: Storage,
    bytes: usize,
    count: usize,
    error: Option<String>,
    relative: String,
}
#[derive(Default)]
struct State {
    entries: HashMap<PathBuf, Entry>,
    versions: HashMap<PathBuf, u64>,
    ram: usize,
    discovered: usize,
    pending: usize,
    skipped: usize,
    failures: HashMap<String, String>,
    ready: bool,
    db: Option<Arc<Database>>,
    spill_path: Option<PathBuf>,
}
impl Drop for State {
    fn drop(&mut self) {
        self.db.take();
        if let Some(p) = &self.spill_path {
            let _ = fs::remove_file(p);
        }
    }
}
struct Engine {
    state: RwLock<State>,
    roots: Vec<PathBuf>,
    exclude: GlobSet,
    budget: usize,
    spill_dir: PathBuf,
    out: Mutex<io::Stdout>,
    latest: AtomicU64,
    stopping: AtomicBool,
    threads: usize,
}
fn emit(engine: &Engine, value: Value) {
    if let Ok(mut out) = engine.out.lock() {
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    }
}
fn status(e: &Engine) -> Value {
    let s = e.state.read().unwrap();
    json!({"event":"status","discovered":s.discovered,"indexed":s.entries.len(),"pending":s.pending,"skipped":s.skipped,"failed":s.failures.len(),"symbols":s.entries.values().map(|x|x.count).sum::<usize>(),"parseErrors":s.entries.values().filter(|x|x.error.is_some()).count(),"indexBytes":s.ram,"budgetBytes":e.budget,"storage":if s.db.is_some(){"disk"}else{"memory"},"ready":s.ready,"failures":s.failures,"parserIssues":s.entries.iter().filter_map(|(p,x)|x.error.as_ref().map(|v|(p.to_string_lossy().to_string(),v.clone()))).collect::<HashMap<_,_>>()})
}
fn allowed_path(e: &Engine, path: &Path) -> bool {
    let Some(root) = e
        .roots
        .iter()
        .filter(|r| path.starts_with(r))
        .max_by_key(|r| r.components().count())
    else {
        return false;
    };
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    if rel
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return false;
    }
    if rel
        .components()
        .any(|c| DEFAULT_EXCLUDES.contains(&c.as_os_str().to_str().unwrap_or("")))
        || e.exclude.is_match(rel)
    {
        return false;
    }
    true
}
fn allowed(e: &Engine, path: &Path) -> bool {
    if !allowed_path(e, path) {
        return false;
    }
    let root = e
        .roots
        .iter()
        .filter(|r| path.starts_with(r))
        .max_by_key(|r| r.components().count())
        .unwrap();
    let mut p = root.clone();
    let rel = path.strip_prefix(root).unwrap();
    for c in rel.components() {
        p.push(c);
        if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
    }
    true
}
fn relative(e: &Engine, p: &Path) -> String {
    let root = e
        .roots
        .iter()
        .filter(|r| p.starts_with(r))
        .max_by_key(|r| r.components().count())
        .unwrap();
    let rel = p.strip_prefix(root).unwrap().to_string_lossy();
    if e.roots.len() > 1 {
        format!(
            "{}/{}",
            root.file_name().unwrap_or_default().to_string_lossy(),
            rel
        )
    } else {
        rel.to_string()
    }
}
fn python(p: &Path) -> bool {
    matches!(p.extension().and_then(|x| x.to_str()), Some("py" | "pyi"))
}
fn records(
    e: &Engine,
    path: &Path,
    text: Option<&str>,
) -> Result<(Vec<Record>, Option<String>), String> {
    if !fs::symlink_metadata(path).is_ok_and(|m| m.is_file()) && text.is_none() {
        return Err("path is not a regular file".into());
    }
    if !python(path) {
        return Ok((vec![], None));
    }
    if text.is_none() && fs::canonicalize(path).map_err(|x| x.to_string())? != path {
        return Err("source path changed or contains a symlink".into());
    }
    if let Some(t) = text {
        if t.len() > e.budget / 8 {
            return Err("source exceeds one eighth of configured memory budget".into());
        }
        return Ok(symbols::extract(
            t,
            path.extension().and_then(|x| x.to_str()) == Some("pyi"),
        ));
    }
    let meta = fs::metadata(path).map_err(|x| x.to_string())?;
    // Bounded transient input; visible failures never masquerade as complete coverage.
    if meta.len() as usize > e.budget / 8 {
        return Err("source exceeds one eighth of configured memory budget".into());
    }
    let bytes = fs::read(path).map_err(|x| x.to_string())?;
    let source = symbols::decode(&bytes)?;
    Ok(symbols::extract(
        &source,
        path.extension().and_then(|x| x.to_str()) == Some("pyi"),
    ))
}
fn create_spill(e: &Engine, s: &mut State) -> Result<(), String> {
    fs::create_dir_all(&e.spill_dir).map_err(|x| x.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&e.spill_dir, fs::Permissions::from_mode(0o700))
            .map_err(|x| x.to_string())?;
    }
    let p = e
        .spill_dir
        .join(format!("index-{}.redb", std::process::id()));
    let f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&p)
        .map_err(|x| x.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|x| x.to_string())?;
    }
    drop(f);
    s.spill_path = Some(p.clone());
    let db = Database::builder()
        .set_cache_size((e.budget / 16).clamp(1024 * 1024, 32 * 1024 * 1024))
        .create(&p)
        .map_err(|x| x.to_string())?;
    s.db = Some(Arc::new(db));
    Ok(())
}
fn persist(db: &Database, p: &Path, r: &[Record]) -> Result<(), String> {
    let bytes = serde_json::to_vec(r).map_err(|x| x.to_string())?;
    let tx = db.begin_write().map_err(|x| x.to_string())?;
    {
        let mut t = tx.open_table(TABLE).map_err(|x| x.to_string())?;
        t.insert(p.to_string_lossy().as_ref(), bytes.as_slice())
            .map_err(|x| x.to_string())?;
    }
    tx.commit().map_err(|x| x.to_string())
}
fn commit(e: &Engine, p: PathBuf, v: u64, result: Result<(Vec<Record>, Option<String>), String>) {
    if e.stopping.load(Ordering::Relaxed) {
        return;
    }
    let mut s = e.state.write().unwrap();
    if s.versions.get(&p).copied().unwrap_or(0) != v {
        return;
    }
    if v == 0
        && p.ancestors()
            .any(|ancestor| s.versions.get(ancestor).is_some_and(|version| *version > 0))
    {
        return;
    }
    if let Some(old) = s.entries.remove(&p) {
        s.ram = s.ram.saturating_sub(old.bytes)
    }
    match result {
        Err(error) => {
            s.failures.insert(p.to_string_lossy().into(), error);
        }
        Ok((r, error)) => {
            s.failures.remove(p.to_string_lossy().as_ref());
            let bytes = std::mem::size_of::<Entry>()
                + p.as_os_str().len()
                + r.iter()
                    .map(|x| {
                        std::mem::size_of::<Record>()
                            + x.name.capacity()
                            + x.qualified.capacity()
                            + x.kind.capacity()
                    })
                    .sum::<usize>();
            // Reserve half the budget for parsers, query snapshots, allocator overhead and metadata.
            let count = r.len();
            let storage_result = (|| -> Result<Storage, String> {
                if s.db.is_none() && s.ram + bytes > e.budget / 2 {
                    create_spill(e, &mut s)?;
                }
                if let Some(db) = s.db.clone() {
                    // Migrate incrementally; avoid materializing a second copy of the index.
                    for (path, entry) in s.entries.iter_mut() {
                        if let Storage::Ram(data) = &entry.storage {
                            persist(&db, path, data)?;
                            entry.storage = Storage::Disk;
                        }
                    }
                    // Recalculate after migration, including partial failure on a prior attempt.
                    for entry in s.entries.values_mut() {
                        if matches!(entry.storage, Storage::Disk) {
                            entry.bytes = 0;
                        }
                    }
                    s.ram = s.entries.values().map(|x| x.bytes).sum();
                    persist(&db, &p, &r)?;
                    Ok(Storage::Disk)
                } else {
                    Ok(Storage::Ram(Arc::new(r)))
                }
            })();
            match storage_result {
                Ok(storage) => {
                    let charged = if matches!(storage, Storage::Ram(_)) {
                        bytes
                    } else {
                        0
                    };
                    s.ram += charged;
                    s.entries.insert(
                        p.clone(),
                        Entry {
                            storage,
                            bytes: charged,
                            count,
                            error,
                            relative: relative(e, &p),
                        },
                    );
                }
                Err(x) => {
                    s.failures
                        .insert(p.to_string_lossy().into(), format!("storage failure: {x}"));
                }
            }
        }
    }
}
fn scan(e: Arc<Engine>) {
    let start = Instant::now();
    let mut last_status = Instant::now();
    let mut first_batch = true;
    let mut files = Vec::with_capacity(32);
    let mut seen = std::collections::HashSet::new();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(e.threads)
        .stack_size(8 * 1024 * 1024)
        .build()
        .unwrap();
    let index_batch = |files: &mut Vec<PathBuf>| {
        pool.install(|| {
            files.par_iter().for_each(|p| {
                // WalkDir already checked every ancestor without following links.
                // Generation zero cannot overwrite a newer editor update/removal.
                commit(&e, p.clone(), 0, records(&e, p, None));
            });
        });
        e.state.write().unwrap().pending -= files.len();
        files.clear();
    };
    emit(&e, status(&e));
    for root in &e.roots {
        for item in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|x| {
                // Checking each ancestor again for every entry is costly on network
                // filesystems. Traversal supplies the file type and never follows links.
                let pass =
                    x.path() == root || (!x.file_type().is_symlink() && allowed_path(&e, x.path()));
                if !pass {
                    e.state.write().unwrap().skipped += 1;
                }
                pass
            })
        {
            if e.stopping.load(Ordering::Relaxed) {
                return;
            }
            match item {
                Ok(x) if x.file_type().is_file() => {
                    if seen.insert(x.path().to_owned()) {
                        files.push(x.path().to_owned());
                        let mut s = e.state.write().unwrap();
                        s.discovered += 1;
                        s.pending += 1;
                    }
                }
                Ok(x) if x.file_type().is_symlink() => e.state.write().unwrap().skipped += 1,
                Ok(_) => {}
                Err(x) => {
                    e.state.write().unwrap().failures.insert(
                        x.path().unwrap_or(root).to_string_lossy().into(),
                        x.to_string(),
                    );
                }
            }
            if files.len() == 32 {
                index_batch(&mut files);
                if first_batch {
                    emit(&e, status(&e));
                    first_batch = false;
                    last_status = Instant::now();
                }
            }
            if last_status.elapsed().as_millis() >= 250 {
                // Flush a partial batch even while slowly discovering the next files.
                index_batch(&mut files);
                emit(&e, status(&e));
                last_status = Instant::now();
            }
        }
    }
    index_batch(&mut files);
    e.state.write().unwrap().ready = true;
    let mut result = status(&e);
    result["elapsedMs"] = json!(start.elapsed().as_secs_f64() * 1000.0);
    emit(&e, result);
}
#[derive(Clone, Serialize)]
struct Hit {
    path: String,
    relative: String,
    name: String,
    qualified: String,
    kind: String,
    line: u32,
    column: u32,
    score: u32,
}
impl PartialEq for Hit {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}
impl Eq for Hit {}
impl PartialOrd for Hit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Hit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.score
            .cmp(&other.score)
            .then_with(|| other.relative.cmp(&self.relative))
            .then_with(|| other.line.cmp(&self.line))
            .then_with(|| other.column.cmp(&self.column))
    }
}
fn query(e: &Engine, id: u64, query: &str, mode: &str, limit: usize, matching: &str) {
    let start = Instant::now();
    let (entries, transaction) = {
        let s = e.state.read().unwrap();
        let transaction = match s.db.as_ref().map(|db| db.begin_read()).transpose() {
            Ok(tx) => tx,
            Err(error) => {
                emit(e, json!({"id":id,"error":error.to_string()}));
                return;
            }
        };
        (
            s.entries
                .iter()
                .map(|(p, x)| (p.clone(), x.clone()))
                .collect::<Vec<_>>(),
            transaction,
        )
    };
    let pattern = Pattern::new(
        query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut utf = Vec::new();
    let mut hits: BinaryHeap<std::cmp::Reverse<Hit>> = BinaryHeap::new();
    let mut total = 0usize;
    let q = query.to_lowercase();
    let mut add = |path: &Path,
                   entry: &Entry,
                   name: &str,
                   qualified: &str,
                   kind: &str,
                   line: u32,
                   column: u32| {
        let text = if kind == "file" {
            entry.relative.as_str()
        } else if matching == "fuzzy" {
            qualified
        } else {
            name
        };
        let score = if query.is_empty() {
            Some(0)
        } else if matching == "substring" {
            text.to_lowercase().contains(&q).then_some(1)
        } else {
            pattern.score(Utf32Str::new(text, &mut utf), &mut matcher)
        };
        if let Some(score) = score {
            let lower = name.to_lowercase();
            let bonus = if lower == q {
                1_000_000
            } else if lower.starts_with(&q) {
                500_000
            } else {
                0
            };
            total += 1;
            let final_score = score + bonus;
            if limit > 0 && hits.len() >= limit {
                let worst = &hits.peek().unwrap().0;
                if final_score < worst.score
                    || (final_score == worst.score
                        && (entry.relative.as_str(), line, column)
                            >= (worst.relative.as_str(), worst.line, worst.column))
                {
                    return;
                }
            }
            hits.push(std::cmp::Reverse(Hit {
                path: path.to_string_lossy().into(),
                relative: entry.relative.clone(),
                name: name.into(),
                qualified: qualified.into(),
                kind: kind.into(),
                line,
                column,
                score: final_score,
            }));
            if limit > 0 && hits.len() > limit {
                hits.pop();
            }
        }
    };
    for (idx, (path, entry)) in entries.iter().enumerate() {
        if idx % 64 == 0
            && (e.latest.load(Ordering::Relaxed) != id || e.stopping.load(Ordering::Relaxed))
        {
            emit(e, json!({"id":id,"cancelled":true}));
            return;
        }
        if mode != "symbols" {
            add(
                path,
                entry,
                path.file_name().unwrap_or_default().to_str().unwrap_or(""),
                &entry.relative,
                "file",
                0,
                0,
            )
        }
        if mode == "files" {
            continue;
        }
        let data = match &entry.storage {
            Storage::Ram(r) => r.clone(),
            Storage::Disk => {
                let loaded = (|| -> Result<Vec<Record>, String> {
                    let tx = transaction.as_ref().ok_or("missing spill database")?;
                    let table = tx.open_table(TABLE).map_err(|x| x.to_string())?;
                    let value = table
                        .get(path.to_string_lossy().as_ref())
                        .map_err(|x| x.to_string())?
                        .ok_or("missing spill record")?;
                    serde_json::from_slice(value.value()).map_err(|x| x.to_string())
                })();
                match loaded {
                    Ok(r) => Arc::new(r),
                    Err(error) => {
                        emit(e, json!({"id":id,"error":error}));
                        return;
                    }
                }
            }
        };
        for (record_index, r) in data.iter().enumerate() {
            if record_index % 1024 == 0
                && (e.latest.load(Ordering::Relaxed) != id || e.stopping.load(Ordering::Relaxed))
            {
                emit(e, json!({"id":id,"cancelled":true}));
                return;
            }
            add(
                path,
                entry,
                &r.name,
                &r.qualified,
                &r.kind,
                r.line,
                r.column,
            )
        }
    }
    let mut hits = hits.into_iter().map(|x| x.0).collect::<Vec<_>>();
    hits.sort_unstable_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.relative.cmp(&b.relative))
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| a.column.cmp(&b.column))
    });
    if limit > 0 {
        hits.truncate(limit)
    }
    let engine_ms = start.elapsed().as_secs_f64() * 1000.0;
    for chunk in hits.chunks(1000) {
        if e.latest.load(Ordering::Relaxed) != id || e.stopping.load(Ordering::Relaxed) {
            emit(e, json!({"id":id,"cancelled":true}));
            return;
        }
        emit(e, json!({"id":id,"chunk":chunk}));
    }
    emit(
        e,
        json!({"id":id,"results":[],"total":total,"engineMs":engine_ms}),
    );
}
fn initialize(v: &Value) -> Result<Arc<Engine>, String> {
    let mut roots = Vec::new();
    for r in v["roots"].as_array().ok_or("roots must be an array")? {
        let p = PathBuf::from(r.as_str().ok_or("invalid root")?);
        if !p.is_absolute() {
            return Err("root must be absolute".into());
        }
        if fs::symlink_metadata(&p)
            .map_err(|x| x.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("symlink roots are not supported".into());
        }
        roots.push(fs::canonicalize(p).map_err(|x| x.to_string())?);
    }
    if roots.is_empty() {
        return Err("no workspace roots".into());
    }
    let mut b = GlobSetBuilder::new();
    if let Some(ex) = v["exclude"].as_array() {
        for x in ex {
            b.add(Glob::new(x.as_str().ok_or("invalid exclude")?).map_err(|x| x.to_string())?);
        }
    }
    let spill_dir = PathBuf::from(v["spillDir"].as_str().ok_or("spillDir required")?);
    if !spill_dir.is_absolute() || roots.iter().any(|r| spill_dir.starts_with(r)) {
        return Err("spillDir must be absolute and outside workspace roots".into());
    }
    let budget = v["memoryBudgetMiB"]
        .as_u64()
        .unwrap_or(1024)
        .clamp(16, 16384) as usize
        * 1024
        * 1024;
    let threads = v["threads"].as_u64().unwrap_or(4).clamp(1, 8) as usize;
    Ok(Arc::new(Engine {
        state: RwLock::new(State::default()),
        roots,
        exclude: b.build().map_err(|x| x.to_string())?,
        budget,
        spill_dir,
        out: Mutex::new(io::stdout()),
        latest: AtomicU64::new(0),
        stopping: AtomicBool::new(false),
        threads,
    }))
}
fn main() {
    let mut engine: Option<Arc<Engine>> = None;
    let mut handles = Vec::new();
    let mut query_thread: Option<std::thread::JoinHandle<()>> = None;
    let mut update_threads: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut input = io::stdin().lock();
    loop {
        let mut line = Vec::new();
        let n = (&mut input)
            .take(16 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .unwrap_or(0);
        if n == 0 {
            break;
        }
        if n > 16 * 1024 * 1024 {
            eprintln!("protocol frame exceeds 16 MiB");
            break;
        }
        let v: Value = match serde_json::from_slice(&line) {
            Ok(x) => x,
            Err(x) => {
                println!("{}", json!({"error":x.to_string()}));
                continue;
            }
        };
        let id = v["id"].as_u64().unwrap_or(0);
        if v["op"] == "init" {
            if engine.is_some() {
                println!(
                    "{}",
                    json!({"id":id,"error":"already initialized; restart to reindex"})
                );
                continue;
            }
            match initialize(&v) {
                Ok(e) => {
                    emit(&e, json!({"id":id,"protocol":1,"pid":std::process::id()}));
                    let copy = e.clone();
                    handles.push(std::thread::spawn(move || scan(copy)));
                    engine = Some(e);
                }
                Err(error) => println!("{}", json!({"id":id,"error":error})),
            }
            continue;
        }
        let Some(e) = engine.clone() else {
            println!("{}", json!({"id":id,"error":"initialize first"}));
            continue;
        };
        match v["op"].as_str().unwrap_or("") {
            "status" => {
                let mut s = status(&e);
                s["id"] = json!(id);
                emit(&e, s)
            }
            "query" => {
                if v["query"].as_str().unwrap_or("").len() > 4096 {
                    emit(&e, json!({"id":id,"error":"query too long"}));
                    continue;
                }
                e.latest.store(id, Ordering::Relaxed);
                if let Some(previous) = query_thread.take() {
                    let _ = previous.join();
                }
                query_thread = Some(std::thread::spawn(move || {
                    query(
                        &e,
                        id,
                        v["query"].as_str().unwrap_or(""),
                        v["mode"].as_str().unwrap_or("all"),
                        v["limit"].as_u64().unwrap_or(100).min(1_000_000) as usize,
                        v["matching"].as_str().unwrap_or("fuzzy"),
                    )
                }));
            }
            "cancel" => {
                e.latest.store(id, Ordering::Relaxed);
                emit(&e, json!({"id":id,"ok":true}));
            }
            "update" | "remove" => {
                let p = PathBuf::from(v["path"].as_str().unwrap_or(""));
                if !allowed(&e, &p) {
                    emit(
                        &e,
                        json!({"id":id,"error":"path is outside allowed source tree"}),
                    );
                    continue;
                }
                let version = {
                    let mut s = e.state.write().unwrap();
                    let n = s.versions.entry(p.clone()).or_insert(0);
                    *n += 1;
                    *n
                };
                if v["op"] == "remove" {
                    let mut s = e.state.write().unwrap();
                    let removed: Vec<_> = s
                        .entries
                        .keys()
                        .chain(s.versions.keys())
                        .filter(|x| x.starts_with(&p))
                        .cloned()
                        .collect();
                    for path in removed {
                        if path != p {
                            *s.versions.entry(path.clone()).or_insert(0) += 1;
                        }
                        if let Some(old) = s.entries.remove(&path) {
                            s.ram = s.ram.saturating_sub(old.bytes);
                        }
                    }
                    s.failures
                        .retain(|path, _| !Path::new(path).starts_with(&p));
                    drop(s);
                    emit(&e, json!({"id":id,"ok":true,"version":version}));
                    emit(&e, status(&e));
                } else {
                    update_threads.retain(|h| !h.is_finished());
                    if update_threads.len() >= 4 {
                        let previous = update_threads.remove(0);
                        let _ = previous.join();
                    }
                    update_threads.push(std::thread::spawn(move || {
                        let res = records(&e, &p, v["text"].as_str());
                        commit(&e, p, version, res);
                        emit(&e, json!({"id":id,"ok":true,"version":version}));
                        emit(&e, status(&e));
                    }));
                }
            }
            "shutdown" => break,
            _ => emit(&e, json!({"id":id,"error":"unknown operation"})),
        }
    }
    if let Some(e) = &engine {
        e.stopping.store(true, Ordering::Relaxed)
    }
    if let Some(h) = query_thread {
        let _ = h.join();
    }
    for h in update_threads {
        let _ = h.join();
    }
    for h in handles {
        let _ = h.join();
    }
}
