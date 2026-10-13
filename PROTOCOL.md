# Worker protocol v1

Newline-delimited UTF-8 JSON over stdio. Requests carry numeric `id`; responses echo it. Status events can arrive at any time. Input frames have a 16 MiB cap. Only the extension controls this process; no socket or external server is exposed.

```json
{"id":1,"op":"init","roots":["/absolute/workspace"],"exclude":[],"memoryBudgetMiB":1024,"spillDir":"/private/session/temp"}
{"id":1,"protocol":1,"pid":1234}
{"event":"status","ready":false,"indexed":32,"discovered":1000,"pending":968,"symbols":800,"failed":0,"parseErrors":0,"skipped":0,"storage":"memory"}
{"id":2,"op":"query","query":"Foo","mode":"symbols","limit":100}
{"id":2,"chunk":[{"path":"/absolute/workspace/a.py","relative":"a.py","name":"Foo","qualified":"Foo","kind":"class","line":0,"column":6,"score":1000500}]}
{"id":2,"results":[],"total":1,"engineMs":0.7}
```

Accumulate chunks (maximum 1,000 hits per frame) until the final response. Positions are zero-based UTF-16, matching VS Code. `mode` is `all`, `files` or `symbols`. `limit:0` requests full export; every eligible file is still indexed regardless of the display limit. Optional `matching:"substring"` searches literal symbol names for diagnostics; normal matching is fuzzy against qualified names.

`status` returns the current state, including maps of failures and parser issues, estimated record memory and budget bytes. `ready:true` means scan finished, not that `failed` or `parseErrors` are zero. `skipped` counts pruned paths/subtree roots, not all descendant files in those subtrees.

`discovered` grows during traversal and is not the final file total until `ready:true`. `pending` counts discovered scan files awaiting processing; editor updates may make `indexed` exceed `discovered` during startup. Results are searchable while discovery and parsing continue. Automatic progress events are limited to roughly four per second.

`update` carries an absolute `path` and optional editor `text`; without text it reloads disk. Per-path generations prevent a stale scan/update from overwriting newer content. `remove` removes a file or every indexed descendant of a directory. Operation acknowledgement means processing finished; inspect status for parse/storage/resource failures. Source is never written. `cancel` invalidates the current query. A cancelled response has `cancelled:true`; discard accumulated chunks. New queries also cancel the previous query. `shutdown` or EOF stops the process and closes temporary storage.

Errors carry `error` and a matching `id` where available. Reinitialization requires a new worker. The client timeout is 120 seconds by default, and clean stop escalates to process kill after three seconds, then removes its session directory.
