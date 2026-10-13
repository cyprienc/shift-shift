"""Generate a CycloneDX inventory of locked Rust and npm dependencies.

Includes build-time dependencies; this is not a claim that every component is
present in the shipped native binary. Requires Python 3.11+; no project imports.
"""
import base64
import datetime
import json
import pathlib
import sys
import tomllib
import urllib.parse
import uuid

manifest = json.loads(pathlib.Path('package.json').read_text())
node_lock = json.loads(pathlib.Path('package-lock.json').read_text())
rust_lock = tomllib.loads(pathlib.Path('engine/Cargo.lock').read_text())
components = {}


def add(ecosystem, name, version, hashes):
    identifier = f'pkg:{ecosystem}/{urllib.parse.quote(name, safe="/")}@{version}'
    components[identifier] = {
        'type': 'library', 'name': name, 'version': version,
        'bom-ref': identifier, 'purl': identifier,
        **({'hashes': hashes} if hashes else {}),
    }


for package in rust_lock['package']:
    if 'source' not in package:
        continue
    if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index':
        raise ValueError('Unexpected Rust dependency source')
    add('cargo', package['name'], package['version'], [{'alg': 'SHA-256', 'content': package['checksum']}])

for location, package in node_lock['packages'].items():
    if not location:
        continue
    if not package['resolved'].startswith('https://registry.npmjs.org/'):
        raise ValueError('Unexpected npm dependency source')
    name = location.rsplit('node_modules/', 1)[-1]
    hashes = []
    for integrity in package.get('integrity', '').split():
        algorithm, encoded = integrity.split('-', 1)
        if algorithm in ('sha256', 'sha384', 'sha512'):
            hashes.append({'alg': algorithm.replace('sha', 'SHA-'), 'content': base64.b64decode(encoded).hex()})
    add('npm', name, package['version'], hashes)

bom = {
    'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1,
    'serialNumber': f'urn:uuid:{uuid.uuid4()}',
    'metadata': {
        'timestamp': datetime.datetime.now(datetime.UTC).isoformat().replace('+00:00', 'Z'),
        'component': {'type': 'application', 'name': manifest['name'], 'version': manifest['version'],
                      'description': 'Locked dependency inventory, including build-time components.'},
    },
    'components': sorted(components.values(), key=lambda item: item['purl']),
}
output = pathlib.Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(bom, indent=2) + '\n')
print(f'Wrote {len(components)} locked components to {output}')
