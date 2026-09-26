"""Feedback loop, part 2: model bundle registry (Astra design, section 4 - Rollback).

A bundle is an immutable, content-addressed directory holding everything a strategy needs: model weights, thresholds,
execution assumptions, feature list, label/replay versions. APPROVED points at the bundle in use; approvals.jsonl is the
append-only history, so rollback always has somewhere to go.

  bid = save_bundle('artifacts/registry', {'models.pt': 'artifacts/corpus/train-v1/models.pt'}, {'thresholds': {...}})
  approve('artifacts/registry', bid, 'Tim')
"""
import hashlib, json, os, shutil, subprocess, time
from research import engine as E

def _read(path):
    with open(path) as f: return f.read()

def _write(path, text):
    with open(path, 'w') as f: f.write(text)

def _sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()

def _git():
    try:
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True, stderr=subprocess.DEVNULL).strip())
        return commit, dirty
    except Exception:
        return None, None

def save_bundle(root, files: dict, meta: dict) -> str:
    """files maps the name inside the bundle to a source path. Returns the bundle id (sha256[:16] of file hashes + meta).
    Saving the same contents again returns the same id and writes nothing."""
    for name in files:
        if os.path.isabs(name) or '..' in name.split('/') or name == 'meta.json': raise ValueError(f'bad file name in bundle: {name}')
    hashes = {name: _sha(src) for name, src in sorted(files.items())}
    identity = json.dumps({'files': hashes, 'meta': meta}, sort_keys=True, default=str)
    bid = hashlib.sha256(identity.encode()).hexdigest()[:16]; path = os.path.join(root, bid)
    if os.path.isdir(path): return bid
    commit, dirty = _git(); tmp = path + '.tmp'
    shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
    for name, src in files.items():
        os.makedirs(os.path.dirname(os.path.join(tmp, name)) or tmp, exist_ok=True); shutil.copy2(src, os.path.join(tmp, name))
    full = {**meta, 'bundle_id': bid, 'files': hashes, 'git_commit': commit, 'git_dirty': dirty, 'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'engine': {'latency_s': E.LATENCY_S, 'cost_per_side': E.COST_PER_SIDE, 'hold_s': E.HOLD_S, 'first_sight_s': E.FIRST_SIGHT_S, 'window_s': E.WINDOW_S}}
    _write(os.path.join(tmp, 'meta.json'), json.dumps(full, indent=1, sort_keys=True, default=str))
    os.rename(tmp, path)   # appears complete or not at all
    return bid

def load_bundle(root, bundle_id) -> dict:
    """Returns meta plus absolute file paths. Raises if any file was changed, added or removed."""
    path = os.path.join(root, bundle_id); meta = json.loads(_read(os.path.join(path, 'meta.json')))
    present = {os.path.relpath(os.path.join(d, f), path) for d, _, fs in os.walk(path) for f in fs} - {'meta.json'}
    if present != set(meta['files']): raise ValueError(f'bundle {bundle_id} contents changed: {sorted(present ^ set(meta["files"]))}')
    for name, h in meta['files'].items():
        if _sha(os.path.join(path, name)) != h: raise ValueError(f'bundle {bundle_id} file changed: {name}')
    return {**meta, 'paths': {name: os.path.join(path, name) for name in meta['files']}}

def _history(root):
    p = os.path.join(root, 'approvals.jsonl')
    return [json.loads(l) for l in _read(p).splitlines() if l.strip()] if os.path.exists(p) else []

def _point(root, bundle_id, approver, action):
    if not approver or not str(approver).strip(): raise ValueError('approver name required')
    load_bundle(root, bundle_id)   # never approve a missing or tampered bundle
    with open(os.path.join(root, 'approvals.jsonl'), 'a') as f:
        f.write(json.dumps({'bundle_id': bundle_id, 'approver': approver, 'action': action, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}) + '\n')
    tmp = os.path.join(root, 'APPROVED.tmp'); _write(tmp, bundle_id + '\n'); os.replace(tmp, os.path.join(root, 'APPROVED'))

def approve(root, bundle_id, approver: str) -> None:
    _point(root, bundle_id, approver, 'approve')

def approved(root):
    p = os.path.join(root, 'APPROVED')
    return _read(p).strip() if os.path.exists(p) else None

def rollback(root, approver: str) -> str:
    """Re-point APPROVED to the bundle that was approved before the current one. Returns that bundle id."""
    stack = []   # replay the history: approve pushes, rollback pops
    for h in _history(root):
        if h['action'] == 'approve': stack.append(h['bundle_id'])
        elif stack: stack.pop()
    if len(stack) < 2: raise ValueError('nothing to roll back to')
    target = stack[-2]
    _point(root, target, approver, 'rollback')
    return target
