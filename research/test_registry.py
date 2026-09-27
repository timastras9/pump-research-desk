"""Registry checks. Run: python -m unittest research/test_registry.py"""
import json, os, tempfile, unittest
from research import registry as R

class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = os.path.join(self.tmp.name, 'reg')
        self.src = os.path.join(self.tmp.name, 'models.pt'); R._write(self.src, 'weights-v1')
    def tearDown(self): self.tmp.cleanup()

    def bundle(self, content, meta=None):
        R._write(self.src, content.decode()); return R.save_bundle(self.root, {'models.pt': self.src}, meta or {'thresholds': {'buy': 0.75}})

    def test_same_contents_same_id_and_no_rewrite(self):
        a = self.bundle(b'w1'); mtime = os.path.getmtime(os.path.join(self.root, a, 'meta.json'))
        self.assertEqual(self.bundle(b'w1'), a)
        self.assertEqual(os.path.getmtime(os.path.join(self.root, a, 'meta.json')), mtime)
        self.assertNotEqual(self.bundle(b'w2'), a)
        self.assertNotEqual(self.bundle(b'w1', {'thresholds': {'buy': 0.7}}), a)   # meta is part of the identity

    def test_meta_records_engine_and_hashes(self):
        m = R.load_bundle(self.root, self.bundle(b'w1'))
        self.assertEqual(m['engine']['latency_s'], 2); self.assertIn('models.pt', m['files']); self.assertTrue(os.path.exists(m['paths']['models.pt']))

    def test_tampered_or_extra_file_raises(self):
        a = self.bundle(b'w1'); R._write(os.path.join(self.root, a, 'models.pt'), 'evil')
        with self.assertRaises(ValueError): R.load_bundle(self.root, a)
        b = self.bundle(b'w2'); R._write(os.path.join(self.root, b, 'extra.bin'), 'x')
        with self.assertRaises(ValueError): R.load_bundle(self.root, b)

    def test_approve_approve_rollback_rollback(self):
        a, b, c = self.bundle(b'a'), self.bundle(b'b'), self.bundle(b'c')
        R.approve(self.root, a, 'Tim'); R.approve(self.root, b, 'Tim'); R.approve(self.root, c, 'Tim')
        self.assertEqual(R.rollback(self.root, 'Tim'), b); self.assertEqual(R.approved(self.root), b)
        self.assertEqual(R.rollback(self.root, 'Tim'), a); self.assertEqual(R.approved(self.root), a)
        with self.assertRaises(ValueError): R.rollback(self.root, 'Tim')
        actions = [json.loads(l)['action'] for l in R._read(os.path.join(self.root, 'approvals.jsonl')).splitlines()]
        self.assertEqual(actions, ['approve', 'approve', 'approve', 'rollback', 'rollback'])

    def test_empty_approver_and_tampered_bundle_cannot_be_approved(self):
        a = self.bundle(b'a')
        with self.assertRaises(ValueError): R.approve(self.root, a, ' ')
        R._write(os.path.join(self.root, a, 'models.pt'), 'evil')
        with self.assertRaises(ValueError): R.approve(self.root, a, 'Tim')
        self.assertIsNone(R.approved(self.root))

    def test_bad_names_rejected(self):
        with self.assertRaises(ValueError): R.save_bundle(self.root, {'../x': self.src}, {})
        with self.assertRaises(ValueError): R.save_bundle(self.root, {'meta.json': self.src}, {})

if __name__ == '__main__':
    unittest.main()
