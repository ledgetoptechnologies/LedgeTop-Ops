"""Unqualified, dedicated-process GTiff->baseline JPEG converter SOURCE.

Default inert. GDAL/NumPy import only inside convert(). This is not a workload
admission adapter: future worker must enforce independent CPU/time/memory limits.
"""
import argparse
import contextlib
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import struct
import sys
import subprocess
import time
import uuid

MIB = 1024**2
LIMITS = {'maxDimension': 65500, 'stripeBytes': 16*MIB, 'gdalCacheBytes': 32*MIB,
          'threads': 1, 'minimumFreeReserveBytes': 64*MIB}
JPEG = {'quality': 90, 'progressive': False, 'optimize': False, 'writeMetadata': False}
ENCODER_PATH='/usr/bin/cjpeg'
ENCODER_SECONDS=600
STDERR_LIMIT=MIB
STRIPE_BYTES_PER_PIXEL = 16  # Conservative simultaneous NumPy buffer accounting.


class Invalid(ValueError):
    pass


def need(value, reason):
    if not value:
        raise Invalid(reason)


def local_path(value):
    return (isinstance(value, str) and len(value)<=4096 and value!='/' and value.startswith('/') and not value.startswith('//')
            and not value.startswith('/vsi') and pathlib.PurePosixPath(value).as_posix()==value
            and '..' not in pathlib.PurePosixPath(value).parts
            and not any(ord(character)<32 for character in value)
            and not any(token in value for token in ('\\', ':')))


def validate_plan(plan):
    fields = {'schemaVersion','kind','operationId','sourceAssetId','sourceVersionId',
              'sourceSha256','sourceByteSize','sourcePath','stagingParent','stagingName',
              'width','height','backgroundRgb','limits','jpeg','encoderSha256'}
    need(isinstance(plan, dict) and set(plan)==fields, 'fixed_plan_fields')
    need(type(plan['schemaVersion']) is int and plan['schemaVersion']==1
         and plan['kind']=='orthophoto-jpeg-v1', 'plan_version_kind')
    try: operation = str(uuid.UUID(plan['operationId']))
    except (ValueError, TypeError, AttributeError): raise Invalid('operation_uuid')
    need(operation==plan['operationId'] and plan['stagingName']=='ortho-jpeg-'+operation,
         'derived_staging_name')
    need(all(isinstance(plan[key],str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',plan[key])
             for key in ('sourceAssetId','sourceVersionId')), 'opaque_source_ids')
    need(isinstance(plan['sourceSha256'],str) and re.fullmatch(r'[a-f0-9]{64}',plan['sourceSha256']),
         'source_hash')
    need(isinstance(plan['encoderSha256'],str) and re.fullmatch(r'[a-f0-9]{64}',plan['encoderSha256']),
         'encoder_hash')
    need(type(plan['sourceByteSize']) is int and 0<plan['sourceByteSize']<=2**53-1, 'source_size')
    need(local_path(plan['sourcePath']) and local_path(plan['stagingParent'])
         and plan['stagingParent']!='/', 'canonical_local_paths')
    need(pathlib.PurePosixPath(plan['sourcePath']).suffix.lower() in ('.tif','.tiff'), 'tiff_extension')
    parent=plan['stagingParent'];source=plan['sourcePath'];stage=parent+'/'+plan['stagingName']
    need(source!=parent and not source.startswith(parent+'/') and not stage.startswith(source+'/'),
         'source_staging_overlap')
    need(json.dumps(plan['limits'],sort_keys=True)==json.dumps(LIMITS,sort_keys=True) and
         json.dumps(plan['jpeg'],sort_keys=True)==json.dumps(JPEG,sort_keys=True), 'fixed_conversion_limits')
    need(all(type(plan[key]) is int and 0<plan[key]<=LIMITS['maxDimension']
             for key in ('width','height')), 'jpeg_dimensions')
    bg=plan['backgroundRgb']
    need(isinstance(bg,list) and len(bg)==3 and all(type(v) is int and 0<=v<=255 for v in bg),
         'explicit_background_rgb')
    return plan


def stripe_rows(width, height):
    need(type(width) is int and type(height) is int and 0<width<=65500 and 0<height<=65500,
         'jpeg_dimensions')
    return min(height, max(1, LIMITS['stripeBytes']//(width*STRIPE_BYTES_PER_PIXEL)))


def required_free_bytes(width,height):
    return 2*width*height*3+LIMITS['minimumFreeReserveBytes']


def validate_bands(metadata, width, height, extras):
    """Pure metadata contract. Color names supplied from explicit GDAL enums."""
    need(metadata['driver']=='GTiff' and metadata['width']==width and metadata['height']==height,
         'exact_gtiff_dimensions')
    need(metadata['colorProfile'] is False,'source_color_profile_unsupported')
    bands=metadata['bands'];colors=[band['color'] for band in bands]
    need(colors in (['Red','Green','Blue'],['Red','Green','Blue','Alpha']), 'explicit_rgb_or_rgba_only')
    need(extras==([] if len(bands)==3 else [2]), 'unassociated_alpha_only')
    for band in bands:
        need(band['type']=='Byte' and band['maskType']=='Byte' and band['palette'] is False,
             'byte_unscaled_no_palette')
        need(band['scale'] in (None,1) and band['offset'] in (None,0), 'unscaled_byte_only')
        nodata=band['nodata']
        need(nodata is None or type(nodata) in (int,float) and 0<=nodata<=255 and int(nodata)==nodata,
             'byte_nodata_only')
        need(type(band['maskFlags']) is int and 0<=band['maskFlags']<=15, 'supported_mask_flags')
        for block,channels in ((band['block'],len(bands)),(band['maskBlock'],1)):
            need(isinstance(block,(tuple,list)) and len(block)==2 and
                 all(type(v) is int and v>0 for v in block) and block[0]*block[1]*channels<=32*MIB,
                 'decoded_source_block_exceeds_32mib')


def file_stamp(s):
    return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,
            s.st_uid,s.st_gid,s.st_mode,s.st_nlink]


def read_at(fd,offset,size):
    need(type(offset) is int and offset>=0 and 0<=size<=128*1024, 'bounded_metadata_read')
    raw=os.pread(fd,size,offset)
    need(len(raw)==size, 'truncated_metadata')
    return raw


def tiff_extrasamples(fd):
    """Read only first-IFD tag338; reject ambiguous associated alpha explicitly."""
    header=read_at(fd,0,8)
    need(header[:2] in (b'II',b'MM'), 'tiff_byte_order')
    endian='<' if header[:2]==b'II' else '>'
    version=struct.unpack(endian+'H',header[2:4])[0]
    if version==42:
        offset=struct.unpack(endian+'I',header[4:8])[0]
        count_size,entry_size,inline=2,12,4
    else:
        need(version==43, 'tiff_header')
        tail=read_at(fd,8,8)
        need(header[4:8]==struct.pack(endian+'HH',8,0), 'bigtiff_offset_size')
        offset=struct.unpack(endian+'Q',tail)[0]
        count_size,entry_size,inline=8,20,8
    need(offset>0,'first_ifd_required')
    count=struct.unpack(endian+('H' if count_size==2 else 'Q'),read_at(fd,offset,count_size))[0]
    need(count<=4096, 'ifd_entry_bound')
    entries=read_at(fd,offset+count_size,count*entry_size);extras=None
    for at in range(0,len(entries),entry_size):
        row=entries[at:at+entry_size];tag,kind=struct.unpack(endian+'HH',row[:4])
        if tag!=338:continue
        need(extras is None and kind==3, 'unique_short_extrasamples')
        n=struct.unpack(endian+('I' if inline==4 else 'Q'),row[4:entry_size-inline])[0]
        need(n<=1,'single_extra_sample_only')
        extras=[] if n==0 else [struct.unpack(endian+'H',row[-inline:][:2])[0]]
    return [] if extras is None else extras


def hash_fd(fd):
    before=os.fstat(fd)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink==1, 'regular_single_link_file')
    digest=hashlib.sha256();at=0
    while at<before.st_size:
        block=os.pread(fd,min(MIB,before.st_size-at),at)
        need(block,'file_truncated');digest.update(block);at+=len(block)
    need(file_stamp(before)==file_stamp(os.fstat(fd)), 'file_changed_during_hash')
    return digest.hexdigest(),file_stamp(before)


def jpeg_header(fd):
    need(read_at(fd,0,2)==b'\xff\xd8','jpeg_magic')
    at=2;size=os.fstat(fd).st_size
    while at<min(size,MIB):
        need(read_at(fd,at,1)==b'\xff','jpeg_marker');at+=1
        marker=read_at(fd,at,1)[0];at+=1
        while marker==255:
            marker=read_at(fd,at,1)[0];at+=1
        need(marker not in (0,0xD8,0xD9,0xDA) and not 0xD0<=marker<=0xD7,'jpeg_header_marker')
        length=struct.unpack('>H',read_at(fd,at,2))[0]
        need(length>=2 and at+length<=min(size,MIB),'jpeg_header_bound')
        if marker==0xE1:need(read_at(fd,at+2,min(6,length-2))!=b'Exif\0\0','unexpected_exif')
        if marker in (0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF):
            need(marker==0xC0 and length>=8,'baseline_jpeg_only')
            body=read_at(fd,at+2,6);precision,h,w,bands=struct.unpack('>BHHB',body)
            need(precision==8 and bands==3 and length==8+3*bands,'byte_rgb_jpeg_only')
            need(size>=4 and read_at(fd,size-2,2)==b'\xff\xd9','jpeg_eoi')
            return w,h,bands
        at+=length
    raise Invalid('jpeg_sof_not_found_within_1mib')


def flatten_channel(np,channel,coverage,background):
    # For each pixel, src*a + bg*(255-a) <=65025; +127<=65152<65536.
    # No scale guess, float buffer, resize, or image-sized allocation is used.
    inverse=np.subtract(np.uint16(255),coverage,dtype=np.uint16)
    weighted=np.multiply(channel,coverage,dtype=np.uint16)
    term=np.multiply(inverse,np.uint16(background),dtype=np.uint16)
    np.add(weighted,term,out=weighted);np.add(weighted,np.uint16(127),out=weighted)
    np.floor_divide(weighted,np.uint16(255),out=weighted)
    return weighted.astype(np.uint8)


@contextlib.contextmanager
def configured(gdal):
    options={'GDAL_PAM_ENABLED':'NO','GDAL_DISABLE_READDIR_ON_OPEN':'EMPTY_DIR',
             'GDAL_NUM_THREADS':'1'}
    previous={key:gdal.GetConfigOption(key) for key in options};cache=gdal.GetCacheMax()
    exceptions=gdal.GetUseExceptions()
    try:
        for key,value in options.items():gdal.SetConfigOption(key,value)
        gdal.SetCacheMax(LIMITS['gdalCacheBytes']);gdal.UseExceptions()
        yield
    finally:
        for key,value in previous.items():gdal.SetConfigOption(key,value)
        gdal.SetCacheMax(cache)
        if not exceptions:gdal.DontUseExceptions()


def native_convert(gdal,np,source_fd,stage_fd,plan,extras):
    source=None;ppm_fd=None
    with configured(gdal):
        try:
            source=gdal.OpenEx('/proc/self/fd/'+str(source_fd),gdal.OF_RASTER|gdal.OF_READONLY,
                               allowed_drivers=['GTiff'])
            need(source is not None,'gtiff_open_failed')
            need(source.RasterCount in (3,4) and source.RasterXSize==plan['width'] and
                 source.RasterYSize==plan['height'],'bounded_rgb_gtiff_metadata')
            colors={gdal.GCI_RedBand:'Red',gdal.GCI_GreenBand:'Green',
                    gdal.GCI_BlueBand:'Blue',gdal.GCI_AlphaBand:'Alpha'}
            bands=[source.GetRasterBand(i+1) for i in range(source.RasterCount)]
            metadata={'driver':source.GetDriver().ShortName,'width':source.RasterXSize,
                'colorProfile':bool(source.GetMetadata('COLOR_PROFILE') or
                    source.GetMetadataItem('SOURCE_ICC_PROFILE') or source.GetMetadataItem('COLOR_PROFILE')),
                'height':source.RasterYSize,'bands':[{'color':colors.get(b.GetColorInterpretation(),'unsupported'),
                 'type':gdal.GetDataTypeName(b.DataType),'palette':b.GetColorTable() is not None,
                 'scale':b.GetScale(),'offset':b.GetOffset(),'nodata':b.GetNoDataValue(),
                 'maskFlags':b.GetMaskFlags(),'block':b.GetBlockSize(),
                 'maskType':gdal.GetDataTypeName(b.GetMaskBand().DataType),
                 'maskBlock':b.GetMaskBand().GetBlockSize()} for b in bands]}
            validate_bands(metadata,plan['width'],plan['height'],extras)
            rows=stripe_rows(plan['width'],plan['height'])
            ppm_fd=os.open('flattened.ppm',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,
                           0o600,dir_fd=stage_fd)
            write_all(ppm_fd,ppm_header(plan['width'],plan['height']))
            for y in range(0,plan['height'],rows):
                height=min(rows,plan['height']-y);shape=(height,plan['width'])
                coverage=np.full(shape,255,dtype=np.uint8)
                if len(bands)==4:
                    alpha=bands[3].ReadAsArray(0,y,plan['width'],height)
                    need(alpha is not None and alpha.shape==shape and alpha.dtype==np.uint8,'alpha_read')
                    np.minimum(coverage,alpha,out=coverage);del alpha
                for band in bands:
                    flags=band.GetMaskFlags()
                    if flags & gdal.GMF_ALL_VALID or len(bands)==4 and flags & gdal.GMF_ALPHA:continue
                    mask=band.GetMaskBand().ReadAsArray(0,y,plan['width'],height)
                    need(mask is not None and mask.shape==shape and mask.dtype==np.uint8,'mask_read')
                    np.minimum(coverage,mask,out=coverage);del mask
                rgb=np.empty((height,plan['width'],3),dtype=np.uint8)
                for index in range(3):
                    channel=bands[index].ReadAsArray(0,y,plan['width'],height)
                    need(channel is not None and channel.shape==shape and channel.dtype==np.uint8,'rgb_read')
                    rgb[:,:,index]=flatten_channel(np,channel,coverage,plan['backgroundRgb'][index])
                    del channel
                write_all(ppm_fd,memoryview(rgb).cast('B'));del coverage,rgb
            os.fsync(ppm_fd)
        finally:
            bands=[];source=None
            if ppm_fd is not None:os.close(ppm_fd)


def ppm_header(width,height):
    need(type(width) is int and type(height) is int and 0<width<=65500 and 0<height<=65500,
         'ppm_dimensions')
    return ('P6\n'+str(width)+' '+str(height)+'\n255\n').encode('ascii')


def write_all(fd,data):
    remaining=memoryview(data)
    while remaining:
        count=os.write(fd,remaining);need(count>0,'output_short_write');remaining=remaining[count:]


def encoder_arguments(encoder_fd,ppm_fd,output_fd):
    return [ENCODER_PATH,'-baseline','-quality','90','-maxmemory','32m',
            '-outfile','/proc/self/fd/'+str(output_fd),'/proc/self/fd/'+str(ppm_fd)]


def encoder_file_limit(width,height):
    return width*height*3+32*MIB


def set_encoder_limit(maximum):
    # Future dedicated child ONLY; pure tests never call resource/native APIs.
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE,(maximum,maximum))


def run_encoder(encoder_fd,ppm_fd,output_fd,stage_fd,plan,receipt):
    """Pinned ELF, bounded pipe drain to private stderr file, exact direct child.

    No communicate/unbounded buffer. Outer worker cgroup remains required for
    uninterruptible tasks and unexpected descendants; reap is not tree closure.
    Future Python launcher must own a new isolated PGID. cjpeg inherits that
    group so outer cleanup can reach it if Python is killed; no group is killed
    here, and no physical/absolute-termination guarantee follows from Popen reap.
    """
    proc=None;stderr_fd=None;selector=None;cancelled=[];old={}
    row={'started':False,'reaped':False,'stderrBytesObserved':0,'stderrBytesRetained':0,
         'timeoutSeconds':ENCODER_SECONDS,'termRequested':False,'killRequested':False,
         'descendantClosureEstablished':False};receipt['encoderChild']=row
    try:
        for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):
            old[sig]=signal.signal(sig,lambda number,frame:cancelled.append(number))
        stderr_fd=os.open('cjpeg.stderr',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,
                          0o600,dir_fd=stage_fd)
        argv=encoder_arguments(encoder_fd,ppm_fd,output_fd);row['argv']=argv
        limit=encoder_file_limit(plan['width'],plan['height']);row['fileSizeLimitBytes']=limit
        proc=subprocess.Popen(argv,executable='/proc/self/fd/'+str(encoder_fd),
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,
            pass_fds=(encoder_fd,ppm_fd,output_fd),start_new_session=False,
            env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LANG':'C'},
            preexec_fn=lambda:set_encoder_limit(limit))
        row.update(started=True,pid=proc.pid)
        selector=selectors.DefaultSelector();selector.register(proc.stderr,selectors.EVENT_READ)
        active_end=time.monotonic()+ENCODER_SECONDS-5
        while selector.get_map() or proc.poll() is None:
            need(not cancelled,'encoder_cancelled');need(time.monotonic()<active_end,'encoder_timeout')
            for key,_ in selector.select(.1):
                block=os.read(key.fileobj.fileno(),4096)
                if not block:selector.unregister(key.fileobj);continue
                row['stderrBytesObserved']+=len(block)
                keep=block[:max(0,STDERR_LIMIT-row['stderrBytesRetained'])]
                if keep:write_all(stderr_fd,keep);row['stderrBytesRetained']+=len(keep)
                need(row['stderrBytesObserved']<=STDERR_LIMIT,'encoder_stderr_limit')
        row['exitCode']=proc.wait(timeout=1);row['reaped']=True
        need(not cancelled,'encoder_cancelled')
        need(row['exitCode']==0,'encoder_exit_failure')
    except BaseException as error:
        row['firstFailure']={'type':type(error).__name__,'message':str(error)[:400]}
        raise
    finally:
        try:
            if proc is not None:
                if proc.poll() is None:
                    row['termRequested']=True
                    try:proc.terminate()
                    except ProcessLookupError:pass
                    try:proc.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        row['killRequested']=True
                        try:proc.kill()
                        except ProcessLookupError:pass
                try:row['exitCode']=proc.wait(timeout=3);row['reaped']=True
                except subprocess.TimeoutExpired:row['cleanupUnproven']=True
        finally:
            if selector is not None:selector.close()
            if proc is not None and proc.stderr is not None:proc.stderr.close()
            if stderr_fd is not None:
                try:os.fsync(stderr_fd)
                finally:os.close(stderr_fd)
            for sig,handler in old.items():signal.signal(sig,handler)
            row['cancelledSignals']=list(cancelled)
        need(proc is None or row['reaped'],'encoder_cleanup_unproven')


def open_encoder(expected):
    binary=pathlib.Path(ENCODER_PATH)
    need(binary.resolve()==binary,'canonical_encoder_binary')
    for parent in binary.parents:
        s=parent.lstat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'protected_encoder_parent')
    fd=os.open(binary,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022 and
             s.st_mode&0o111 and s.st_nlink==1,'protected_encoder_binary')
        digest,identity=hash_fd(fd)
        need(digest==expected and identity==file_stamp(binary.lstat()),'encoder_binary_binding')
        return fd,identity
    except BaseException:os.close(fd);raise


def convert(plan):
    validate_plan(plan)
    need(os.name=='posix' and hasattr(os,'pread') and pathlib.Path('/proc/self/fd').is_dir(),
         'linux_fd_backed_conversion_required')
    source_path=pathlib.Path(plan['sourcePath']);parent=pathlib.Path(plan['stagingParent'])
    need(source_path.resolve()==source_path and parent.resolve()==parent,'canonical_existing_paths')
    initial=source_path.lstat()
    need(stat.S_ISREG(initial.st_mode) and initial.st_nlink==1,'regular_single_link_source')
    source_fd=os.open(source_path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    parent_fd=stage_fd=encoder_fd=ppm_fd=output_fd=None;receipt={'schemaVersion':1,'status':'FAILED_PRIVATE_EVIDENCE_RETAINED',
        'operationId':plan['operationId'],'executionAdmissionEstablished':False,'accepted':False}
    try:
        before_hash,before_stamp=hash_fd(source_fd)
        need(before_hash==plan['sourceSha256'] and before_stamp[2]==plan['sourceByteSize'] and
             before_stamp==file_stamp(initial) and
             file_stamp(source_path.lstat())==before_stamp,'source_binding')
        extras=tiff_extrasamples(source_fd)
        parent_fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        ps=os.fstat(parent_fd)
        need(stat.S_IMODE(ps.st_mode)==0o700 and ps.st_uid==os.geteuid() and
             file_stamp(parent.lstat())==file_stamp(ps),'canonical_private_staging_parent')
        available=os.fstatvfs(parent_fd)
        need(available.f_bavail*available.f_frsize>=required_free_bytes(plan['width'],plan['height']),
             'disk_headroom')
        os.mkdir(plan['stagingName'],0o700,dir_fd=parent_fd)  # O_EXCL equivalent for directory.
        stage_fd=os.open(plan['stagingName'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_fd)
        os.fsync(parent_fd)
        ss=os.fstat(stage_fd)
        need(stat.S_IMODE(ss.st_mode)==0o700 and ss.st_uid==os.geteuid(),'new_private_staging')
        encoder_fd,encoder_identity=open_encoder(plan['encoderSha256'])
        # Lazy native imports: pure metadata/plan tests never load either module.
        for key in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):
            os.environ[key]='1'
        need('numpy' not in sys.modules,'dedicated_fresh_numpy_process_required')
        from osgeo import gdal
        import numpy as np
        native_convert(gdal,np,source_fd,stage_fd,plan,extras)
        ppm_fd=os.open('flattened.ppm',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=stage_fd)
        ppm_before=os.fstat(ppm_fd)
        need(stat.S_ISREG(ppm_before.st_mode) and ppm_before.st_nlink==1 and
             ppm_before.st_size==len(ppm_header(plan['width'],plan['height']))+plan['width']*plan['height']*3,
             'exact_ppm_payload')
        output_fd=os.open('image.jpg',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,
                          0o600,dir_fd=stage_fd)
        run_encoder(encoder_fd,ppm_fd,output_fd,stage_fd,plan,receipt)
        encoder_after,encoder_stamp=hash_fd(encoder_fd)
        need(encoder_after==plan['encoderSha256'] and encoder_stamp==encoder_identity==
             file_stamp(pathlib.Path(ENCODER_PATH).lstat()),'encoder_changed_after_conversion')
        need(file_stamp(os.fstat(ppm_fd))==file_stamp(ppm_before),'ppm_changed_during_encoding')
        need(set(os.listdir(stage_fd))=={'flattened.ppm','image.jpg','cjpeg.stderr'},'unexpected_output_or_sidecar')
        outputs={}
        for name in ('flattened.ppm','image.jpg','cjpeg.stderr'):
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=stage_fd)
            try:
                if name=='image.jpg':need(jpeg_header(fd)==(plan['width'],plan['height'],3),'jpeg_header_dimensions')
                digest,identity=hash_fd(fd);os.fsync(fd)
                outputs[name]={'sha256':digest,'byteSize':identity[2],'identity':identity}
            finally:os.close(fd)
        after_hash,after_stamp=hash_fd(source_fd)
        need(after_hash==before_hash and after_stamp==before_stamp==file_stamp(source_path.lstat()),
             'source_changed_after_conversion')
        receipt.update(status='JPEG_CREATED_PENDING_INDEPENDENT_REVIEW',sourceUnchanged=True,
            sourceAssetId=plan['sourceAssetId'],sourceVersionId=plan['sourceVersionId'],
            sourceSha256=before_hash,sourceByteSize=plan['sourceByteSize'],sourceIdentity=before_stamp,
            width=plan['width'],height=plan['height'],bands=3,backgroundRgb=plan['backgroundRgb'],
            quality=90,progressive=False,optimize=False,writeMetadata=False,outputs=outputs,
            encoderSha256=encoder_after,encoderIdentity=encoder_stamp)
    except BaseException as error:
        receipt.update(errorType=type(error).__name__,error=str(error)[:400])
        if encoder_fd is not None:
            try:
                digest,identity=hash_fd(encoder_fd)
                receipt['encoderPostFailureCheck']={'sha256':digest,'identity':identity,
                    'unchanged':digest==plan['encoderSha256'] and identity==encoder_identity==
                        file_stamp(pathlib.Path(ENCODER_PATH).lstat())}
            except Exception as check_error:receipt['encoderPostFailureCheckError']=str(check_error)[:200]
        if stage_fd is not None:write_receipt(stage_fd,receipt)
        raise
    else:
        write_receipt(stage_fd,receipt)
        return receipt
    finally:
        for fd in (output_fd,ppm_fd,encoder_fd,stage_fd,parent_fd,source_fd):
            if fd is not None:os.close(fd)


def write_receipt(stage_fd,receipt):
    fd=os.open('receipt.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=stage_fd)
    try:
        with os.fdopen(fd,'wb',closefd=False) as stream:
            stream.write((json.dumps(receipt,sort_keys=True)+'\n').encode());stream.flush();os.fsync(fd)
    finally:os.close(fd)
    os.fsync(stage_fd)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--convert',action='store_true');parser.add_argument('--plan');args=parser.parse_args()
    if not args.convert:
        print('SOURCE_CONVERTER_NOT_ADMITTED');return
    need(local_path(args.plan),'canonical_plan_path')
    path=pathlib.Path(args.plan);need(path.resolve()==path,'canonical_plan_path')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=65536,'bounded_plan_file')
        raw=os.read(fd,65537)
        need(len(raw)==before.st_size and file_stamp(before)==file_stamp(os.fstat(fd)),'plan_changed')
    finally:os.close(fd)
    print(json.dumps(convert(json.loads(raw)),sort_keys=True))


if __name__=='__main__':main()
