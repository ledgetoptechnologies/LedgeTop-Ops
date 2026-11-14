"""Pure converter contract/metadata tests: no GDAL, NumPy, files or native IO."""
import copy
import importlib.util
import io
import pathlib
import struct
import sys
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('orthophoto_jpeg_source',
    pathlib.Path(__file__).parents[1]/'scripts'/'orthophoto-jpeg.py')
J=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(J)


def plan():
    operation='11111111-2222-4333-8444-555555555555'
    return {'schemaVersion':1,'kind':'orthophoto-jpeg-v1','operationId':operation,
            'sourceAssetId':'asset_1','sourceVersionId':'version-2','sourceSha256':'a'*64,
            'sourceByteSize':100,'sourcePath':'/data/ortho.tif','stagingParent':'/private/jobs',
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
                          ('jpeg',{'quality':90,'progressive':True,'writeMetadata':False}),
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

    def test_only_baseline_supported_creation_options(self):
        self.assertEqual(J.JPEG_OPTIONS,['QUALITY=90','WRITE_EXIF_METADATA=NO','INTERNAL_MASK=NO','WORLDFILE=NO'])
        self.assertFalse(J.JPEG['progressive'])
        self.assertFalse(any('PROGRESSIVE' in value or 'OPTIMIZE' in value for value in J.JPEG_OPTIONS))


if __name__=='__main__':unittest.main()
