"""Pure converter contract/metadata tests: no GDAL, NumPy, files or native IO."""
import copy
import importlib.util
import io
import pathlib
import struct
import sys
import unittest
import types
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('orthophoto_jpeg_source',
    pathlib.Path(__file__).parents[1]/'scripts'/'orthophoto-jpeg.py')
J=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(J)


def plan():
    operation='11111111-2222-4333-8444-555555555555'
    return {'schemaVersion':1,'kind':'orthophoto-jpeg-v1','operationId':operation,
            'sourceAssetId':'asset_1','sourceVersionId':'version-2','sourceSha256':'a'*64,
            'sourceByteSize':100,'sourcePath':'/data/ortho.tif','stagingParent':'/private/jobs',
            'encoderSha256':'b'*64,
            'stagingName':'ortho-jpeg-'+operation,'width':65500,'height':200,
            'backgroundRgb':[255,255,255],'limits':dict(J.LIMITS),'jpeg':dict(J.JPEG)}


def metadata(alpha=False):
    return {'driver':'GTiff','width':20,'height':10,'colorProfile':False,'bands':[
        {'color':color,'type':'Byte','palette':False,'scale':None,'offset':None,'nodata':None,
         'maskType':'Byte','maskFlags':1,'block':(20,1),'maskBlock':(20,1)}
        for color in (['Red','Green','Blue','Alpha'] if alpha else ['Red','Green','Blue'])]}


class ContractTests(unittest.TestCase):
    def test_plan_fixed_fields_dimensions_background_and_no_lazy_imports(self):
        J.validate_plan(plan())
        self.assertNotIn('numpy',sys.modules);self.assertNotIn('osgeo.gdal',sys.modules)
        for key,value in [('width',65501),('width',True),('sourceByteSize',0),
                          ('backgroundRgb',[255,True,0]),('sourceAssetId','../bad'),
                          ('jpeg',{'quality':90,'progressive':True,'optimize':False,'writeMetadata':False}),
                          ('encoderSha256','wrong'),
                          ('schemaVersion',True),('stagingName','other')]:
            p=plan();p[key]=value
            with self.subTest(key=key),self.assertRaises(J.Invalid):J.validate_plan(p)

    def test_local_paths_extension_and_overlap_rejected(self):
        for value in ('/','/vsimem/file.tif','https://example/file.tif','//host/file.tif',
                      '/data/../ortho.tif','/data/./ortho.tif','/data/a:b.tif','/data/a\t.tif',
                      '/'+('x'*4097)+'.tif','/data/file.tif/'):
            p=plan();p['sourcePath']=value
            with self.subTest(value=value),self.assertRaises(J.Invalid):J.validate_plan(p)
        p=plan();p['sourcePath']='/data/not-a-tiff.jpg'
        with self.assertRaisesRegex(J.Invalid,'tiff_extension'):J.validate_plan(p)
        p=plan();p['sourcePath']='/private/jobs/source.tif'
        with self.assertRaisesRegex(J.Invalid,'source_staging_overlap'):J.validate_plan(p)

    def test_stripes_and_required_headroom(self):
        for width,height in [(1,1),(65500,65500),(5000,4000)]:
            rows=J.stripe_rows(width,height)
            self.assertLessEqual(rows*width*J.STRIPE_BYTES_PER_PIXEL,16*J.MIB)
            self.assertLessEqual(rows,height)
            self.assertEqual(J.required_free_bytes(width,height),width*height*6+64*J.MIB)

    def test_explicit_byte_rgb_alpha_and_decoded_block_bound(self):
        J.validate_bands(metadata(),20,10,[])
        J.validate_bands(metadata(True),20,10,[2])
        tagged=metadata();tagged['colorProfile']=True
        with self.assertRaisesRegex(J.Invalid,'source_color_profile_unsupported'):
            J.validate_bands(tagged,20,10,[])
        for field,value,reason in [('type','UInt16','byte_unscaled'),('color','Palette','explicit_rgb'),
            ('scale',2,'unscaled'),('nodata',float('nan'),'byte_nodata'),
            ('block',(65500,65500),'decoded_source_block'),('maskBlock',(65500,65500),'decoded_source_block')]:
            row=metadata();row['bands'][0][field]=value
            with self.subTest(field=field),self.assertRaisesRegex(J.Invalid,reason):
                J.validate_bands(row,20,10,[])
        for extras in ([],[0],[1],[2,2]):
            with self.assertRaisesRegex(J.Invalid,'unassociated_alpha'):
                J.validate_bands(metadata(True),20,10,extras)

    def test_classic_and_bigtiff_extras_only_bounded_metadata_reads(self):
        for endian,order in [('<',b'II'),('>',b'MM')]:
            for big in (False,True):
                if big:
                    raw=order+struct.pack(endian+'HHHQ',43,8,0,16)+struct.pack(endian+'Q',1)
                    raw+=struct.pack(endian+'HHQH',338,3,1,2)+b'\0'*6
                else:
                    raw=order+struct.pack(endian+'HIH',42,8,1)+struct.pack(endian+'HHIH',338,3,1,2)+b'\0'*2
                def read(fd,offset,size):
                    self.assertLessEqual(size,128*1024);return raw[offset:offset+size]
                with patch.object(J,'read_at',side_effect=read):
                    self.assertEqual(J.tiff_extrasamples(9),[2])
        oversized=b'II'+struct.pack('<HIH',42,8,4097)
        with patch.object(J,'read_at',side_effect=lambda fd,at,n:oversized[at:at+n]):
            with self.assertRaisesRegex(J.Invalid,'ifd_entry_bound'):J.tiff_extrasamples(9)

    def test_jpeg_header_requires_baseline_and_exact_shape_not_progressive(self):
        for marker in (0xC0,0xC2):
            raw=b'\xff\xd8\xff'+bytes([marker])+struct.pack('>HBHHB',17,8,10,20,3)
            raw+=bytes([1,0x22,0,2,0x11,1,3,0x11,1])+b'\xff\xd9'
            with patch.object(J,'read_at',side_effect=lambda fd,at,n:raw[at:at+n]),\
                 patch.object(J.os,'fstat',return_value=type('S',(),{'st_size':len(raw)})()):
                if marker==0xC0:self.assertEqual(J.jpeg_header(9),(20,10,3))
                else:
                    with self.assertRaisesRegex(J.Invalid,'baseline_jpeg_only'):J.jpeg_header(9)

    def test_only_fixed_baseline_nonoptimized_encoder_arguments(self):
        self.assertEqual(J.encoder_arguments(7,8,9),['/usr/bin/cjpeg','-baseline','-quality','90',
            '-maxmemory','32m','-outfile','/proc/self/fd/9','/proc/self/fd/8'])
        self.assertFalse(J.JPEG['progressive'])
        self.assertFalse(J.JPEG['optimize'])
        self.assertEqual(J.ppm_header(20,10),b'P6\n20 10\n255\n')
        self.assertLess(J.encoder_file_limit(20,10),J.required_free_bytes(20,10))
        source=pathlib.Path(SPEC.origin).read_text()
        self.assertNotIn('CreateCopy(',source)

    def test_child_argv_descriptors_environment_and_success_are_mocked_only(self):
        self.mock_encoder('success')

    def test_timeout_kills_and_reaps_exact_direct_child(self):
        self.mock_encoder('timeout')

    def test_unreapable_child_and_stderr_overflow_never_claim_closure(self):
        self.mock_encoder('unreapable')
        self.mock_encoder('overflow')

    def test_cancel_after_pipe_close_is_recorded_and_never_success(self):
        self.mock_encoder('cancel')

    def mock_encoder(self,scenario):
        class Pipe:
            def fileno(self):return 33
            def close(self):pass
        class Process:
            pid=123;stderr=Pipe();done=False;killed=False;terminated=False
            def poll(self):return 0 if self.done else None
            def terminate(self):self.terminated=True
            def kill(self):self.killed=True
            def wait(self,timeout):
                if scenario=='unreapable' or scenario=='timeout' and not self.killed:
                    raise J.subprocess.TimeoutExpired('fixed-cjpeg',timeout)
                self.done=True;return -9 if self.killed else 0
        proc=Process()
        callbacks={}
        class Selector:
            registered=True
            def register(self,*args):pass
            def unregister(self,*args):self.registered=False;proc.done=True
            def get_map(self):return {1:1} if self.registered else {}
            def select(self,timeout):
                if scenario=='cancel':callbacks[J.signal.SIGTERM](J.signal.SIGTERM,None)
                return [(types.SimpleNamespace(fileobj=proc.stderr),1)]
            def close(self):pass
        chunks=iter([b'large-log' if scenario=='overflow' else b'',b''])
        clocks=iter([0,600]) if scenario in ('timeout','unreapable') else None
        receipt={}
        def install(number,handler):callbacks[number]=handler
        with (patch.object(J.os,'O_NOFOLLOW',131072,create=True),
              patch.object(J.signal,'SIGHUP',1,create=True),patch.object(J.signal,'signal',side_effect=install),
              patch.object(J.os,'open',return_value=44),patch.object(J.os,'close'),
              patch.object(J.os,'fsync'),patch.object(J.os,'read',side_effect=lambda *args:next(chunks)),
              patch.object(J,'write_all') as written,
              patch.object(J.selectors,'DefaultSelector',return_value=Selector()),
              patch.object(J.subprocess,'Popen',return_value=proc) as launch,
              patch.object(J,'STDERR_LIMIT',4),
              patch.object(J.time,'monotonic',side_effect=(lambda:next(clocks)) if clocks else lambda:0),
              patch.object(J,'set_encoder_limit') as limit):
            if scenario=='success':J.run_encoder(7,8,9,10,plan(),receipt)
            else:
                reason={'timeout':'encoder_timeout','unreapable':'encoder_cleanup_unproven',
                        'overflow':'encoder_stderr_limit','cancel':'encoder_cancelled'}[scenario]
                with self.assertRaisesRegex(J.Invalid,reason):J.run_encoder(7,8,9,10,plan(),receipt)
            arguments,options=launch.call_args
            self.assertEqual(arguments[0],J.encoder_arguments(7,8,9))
            self.assertEqual(options['executable'],'/proc/self/fd/7')
            self.assertEqual(options['pass_fds'],(7,8,9))
            self.assertIs(options['start_new_session'],False)
            self.assertEqual(options['stdout'],J.subprocess.DEVNULL)
            self.assertEqual(options['env'],{'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LANG':'C'})
            options['preexec_fn']();limit.assert_called_once_with(J.encoder_file_limit(65500,200))
            if scenario=='overflow':self.assertEqual(written.call_args.args[1],b'larg')
        row=receipt['encoderChild']
        self.assertEqual(row['reaped'],scenario!='unreapable')
        self.assertFalse(row['descendantClosureEstablished'])
        if scenario in ('timeout','unreapable'):self.assertTrue(proc.killed)
        if scenario=='unreapable':
            self.assertEqual(row['firstFailure'],{'type':'Invalid','message':'encoder_timeout'})
            self.assertTrue(row['cleanupUnproven'])
        if scenario=='cancel':self.assertEqual(row['cancelledSignals'],[J.signal.SIGTERM])


if __name__=='__main__':unittest.main()
