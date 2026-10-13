use crate::Record;
use ruff_python_ast::{
    Expr, PySourceType, Stmt,
    visitor::{Visitor, walk_stmt},
};
use ruff_text_size::TextRange;

pub fn decode(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let head = bytes
        .split(|b| *b == b'\n')
        .take(2)
        .map(|l| String::from_utf8_lossy(l))
        .collect::<Vec<_>>()
        .join("\n");
    let mut label = None;
    for line in head.lines() {
        if !line.trim_start().starts_with('#') {
            continue;
        }
        if let Some(pos) = line.find("coding") {
            let tail = &line[pos + 6..];
            if let Some(t) = tail.strip_prefix(':').or_else(|| tail.strip_prefix('=')) {
                label = Some(
                    t.trim_start()
                        .split(|c: char| {
                            !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
                        })
                        .next()
                        .unwrap_or("")
                        .to_ascii_lowercase(),
                );
            }
        }
    }
    let label = label.unwrap_or_else(|| "utf-8".into());
    if ["utf-8", "utf8", "utf_8"].contains(&label.as_str()) {
        return String::from_utf8(bytes.to_vec()).map_err(|x| x.to_string());
    }
    if ["latin-1", "latin1", "iso-8859-1", "iso8859-1", "latin_1"].contains(&label.as_str()) {
        return Ok(bytes.iter().map(|x| char::from(*x)).collect());
    }
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("unsupported source encoding {label}"))?;
    let (text, _, errors) = encoding.decode(bytes);
    if errors {
        return Err(format!("invalid source encoding {label}"));
    }
    Ok(text.into_owned())
}
struct Extractor<'a> {
    source: &'a str,
    lines: Vec<usize>,
    scope: Vec<(String, bool)>,
    records: Vec<Record>,
}
impl Extractor<'_> {
    fn add(&mut self, name: &str, range: TextRange, kind: &str) {
        if name.is_empty() {
            return;
        }
        let offset = usize::from(range.start());
        if offset > self.source.len() || !self.source.is_char_boundary(offset) {
            return;
        }
        let line = self
            .lines
            .partition_point(|x| *x <= offset)
            .saturating_sub(1);
        let column = self.source[self.lines[line]..offset].encode_utf16().count();
        let mut names = self.scope.iter().map(|x| x.0.as_str()).collect::<Vec<_>>();
        names.push(name);
        self.records.push(Record {
            name: name.into(),
            qualified: names.join("."),
            kind: kind.into(),
            line: line as u32,
            column: column as u32,
        });
    }
    fn binding(&mut self, expr: &Expr, kind: &str) {
        match expr {
            Expr::Name(n) => {
                let k = if kind == "variable"
                    && n.id.as_str().chars().any(|c| c.is_alphabetic())
                    && n.id
                        .as_str()
                        .chars()
                        .filter(|c| c.is_alphabetic())
                        .all(|c| c.is_uppercase())
                {
                    "constant"
                } else {
                    kind
                };
                self.add(n.id.as_str(), n.range, k)
            }
            Expr::Tuple(x) => {
                for e in &x.elts {
                    self.binding(e, kind)
                }
            }
            Expr::List(x) => {
                for e in &x.elts {
                    self.binding(e, kind)
                }
            }
            Expr::Starred(x) => self.binding(&x.value, kind),
            _ => {}
        }
    }
    fn module_or_class(&self) -> bool {
        self.scope.last().is_none_or(|x| x.1)
    }
}
impl<'a> Visitor<'a> for Extractor<'a> {
    fn visit_stmt(&mut self, stmt: &'a Stmt) {
        match stmt {
            Stmt::FunctionDef(x) => {
                let k = if self.scope.last().is_some_and(|x| x.1) {
                    "method"
                } else {
                    "function"
                };
                self.add(x.name.as_str(), x.name.range, k);
                self.scope.push((x.name.to_string(), false));
                for s in &x.body {
                    self.visit_stmt(s)
                }
                self.scope.pop();
            }
            Stmt::ClassDef(x) => {
                self.add(x.name.as_str(), x.name.range, "class");
                self.scope.push((x.name.to_string(), true));
                for s in &x.body {
                    self.visit_stmt(s)
                }
                self.scope.pop();
            }
            Stmt::Assign(x) if self.module_or_class() => {
                for t in &x.targets {
                    self.binding(t, "variable")
                }
            }
            Stmt::AnnAssign(x) if self.module_or_class() => self.binding(&x.target, "variable"),
            Stmt::TypeAlias(x) if self.module_or_class() => self.binding(&x.name, "typeAlias"),
            _ => walk_stmt(self, stmt),
        }
    }
    fn visit_expr(&mut self, _: &'a Expr) {}
}
pub fn extract(source: &str, stub: bool) -> (Vec<Record>, Option<String>) {
    let parsed = ruff_python_parser::parse_unchecked_source(
        source,
        if stub {
            PySourceType::Stub
        } else {
            PySourceType::Python
        },
    );
    let errors = (!parsed.errors().is_empty()).then(|| {
        format!(
            "{} parse errors; recovered definitions shown",
            parsed.errors().len()
        )
    });
    let mut lines = vec![0];
    lines.extend(
        source
            .bytes()
            .enumerate()
            .filter_map(|(i, c)| (c == b'\n').then_some(i + 1)),
    );
    let mut visitor = Extractor {
        source,
        lines,
        scope: vec![],
        records: vec![],
    };
    for stmt in &parsed.syntax().body {
        visitor.visit_stmt(stmt)
    }
    visitor.records.sort_by_key(|x| (x.line, x.column));
    visitor
        .records
        .dedup_by(|a, b| a.name == b.name && a.line == b.line && a.column == b.column);
    (visitor.records, errors)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn definitions_and_positions() {
        let (r, e) = extract(
            "a='😀'; café = 1\nclass A:\n    X: int\n    async def method(self):\n        local = 1\n        def nested(): pass\n",
            false,
        );
        assert!(e.is_none());
        assert_eq!(
            r.iter().map(|x| x.qualified.as_str()).collect::<Vec<_>>(),
            vec!["a", "café", "A", "A.X", "A.method", "A.method.nested"]
        );
        assert_eq!(r[1].column, 8);
        assert_eq!(r[4].kind, "method");
    }
    #[test]
    fn aliases_and_incomplete() {
        let (r, e) = extract(
            "type Alias[T] = list[T]\ndef intact(): pass\ndef broken(\n",
            false,
        );
        assert!(e.is_some());
        assert!(r.iter().any(|x| x.name == "Alias" && x.kind == "typeAlias"));
        assert!(r.iter().any(|x| x.name == "intact"));
    }
    #[test]
    fn encoding() {
        assert_eq!(
            decode(b"# coding: latin-1\ncaf\xe9=1\n").unwrap(),
            "# coding: latin-1\ncafé=1\n"
        );
        assert!(decode(b"\xff").is_err());
    }
}
