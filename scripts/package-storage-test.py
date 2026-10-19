from pathlib import Path
import importlib.util, json, tempfile, unittest
spec=importlib.util.spec_from_file_location('storage',Path(__file__).with_name('package-storage.py'))
storage=importlib.util.module_from_spec(spec);spec.loader.exec_module(storage)
class CleanupTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
  self.outside=self.root/'keep';self.outside.mkdir();(self.outside/'user.txt').write_text('keep')
 def tearDown(self):self.temp.cleanup()
 def test_generated_links_do_not_delete_targets(self):
  stage=self.root/'stage';stage.mkdir();(stage/'Applications').symlink_to(self.outside,target_is_directory=True)
  (stage/'bundle').mkdir();(stage/'bundle'/'file').write_text('test')
  storage.remove_generated(stage,self.root,{'Applications','bundle'})
  self.assertFalse(stage.exists());self.assertEqual((self.outside/'user.txt').read_text(),'keep')
 def test_unknown_files_preserve_entire_directory(self):
  stage=self.root/'stage';stage.mkdir();(stage/'unexpected').write_text('keep')
  with self.assertRaises(ValueError):storage.remove_generated(stage,self.root,{'bundle'})
  self.assertTrue((stage/'unexpected').exists())
 def test_top_symlink_rejected(self):
  stage=self.root/'stage';stage.symlink_to(self.outside,target_is_directory=True)
  with self.assertRaises(ValueError):storage.remove_generated(stage,self.root,{'user.txt'})
  self.assertTrue((self.outside/'user.txt').exists())
 def test_outside_root_rejected(self):
  with self.assertRaises(ValueError):storage.remove_generated(self.outside,self.root/'different',{'user.txt'})
  self.assertTrue(self.outside.exists())
 def test_concurrent_packaging_rejected(self):
  with storage.package_lock(self.root):
   with self.assertRaises(BlockingIOError):
    with storage.package_lock(self.root): pass
  with storage.package_lock(self.root):pass
if __name__=='__main__':
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(CleanupTests)
 result=unittest.TextTestRunner().run(suite)
 report={'passed':result.wasSuccessful(),'cases':result.testsRun,'scope':'generated package directories, symlink boundaries and exclusive packaging lock'}
 Path(__file__).resolve().parent.parent.joinpath('evidence/package-storage-test.json').write_text(json.dumps(report,indent=2)+'\n')
 raise SystemExit(0 if result.wasSuccessful() else 1)
