import datetime as dt
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock
import zipfile
import consumer as c

DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

def office(main='word/document.xml', modifications=None):
    word = main.startswith('word/')
    main_type = 'application/vnd.openxmlformats-officedocument.' + ('wordprocessingml.document.main+xml' if word else 'spreadsheetml.sheet.main+xml')
    ns = 'wordprocessingml' if word else 'spreadsheetml'
    tag = 'document' if word else 'workbook'
    parts = {'[Content_Types].xml': f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{main}" ContentType="{main_type}"/></Types>',
             '_rels/.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{main}"/></Relationships>',
             main: f'<{tag} xmlns="http://schemas.openxmlformats.org/{ns}/2006/main"/>'}
    parts.update(modifications or {})
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items(): archive.writestr(name, value)
    return output.getvalue()

class Validation(unittest.TestCase):
    def setUp(self): self.tmp = tempfile.TemporaryDirectory(); self.path = Path(self.tmp.name) / 'file'
    def tearDown(self): self.tmp.cleanup()
    def check(self, data, name, mime): self.path.write_bytes(data); c.validate_file(self.path, name, mime)
    def reject(self, data, name='agreement.docx', mime=DOCX):
        with self.assertRaises(c.Rejected): self.check(data, name, mime)
    def test_real_office_structure_and_type(self):
        self.check(office(), 'agreement.docx', DOCX)
        self.check(office('xl/workbook.xml'), 'tax.xlsx', XLSX)
        self.reject(b'PK\x03\x04not a zip')
        self.reject(office(), 'tax.xlsx', XLSX)
        self.reject(office(), 'agreement.docm', DOCX)
    def test_office_active_content_and_external_relationships(self):
        for name in ('word/vbaProject.bin', 'word/embeddings/payload.zip', 'word/activeX/control.xml'):
            self.reject(office(modifications={name: b'payload'}))
        self.reject(office(modifications={'word/_rels/document.xml.rels': '<Relationships><Relationship TargetMode="External" Target="https://example.test/evil"/></Relationships>'}))
        self.reject(office(modifications={'word/document.xml': '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><instrText>DDEAUTO</instrText></document>'}))
        self.reject(office('xl/workbook.xml', {'xl/worksheets/sheet1.xml': '<worksheet><f>WEBSERVICE("https://example.test")</f></worksheet>'}), 'tax.xlsx', XLSX)
    def test_zip_paths_bombs_and_entities(self):
        self.reject(office(modifications={'../evil.xml': '<x/>'}))
        self.reject(office(modifications={'word/large.xml': 'A' * (9 * 1024 * 1024)}))
        self.reject(office(modifications={'word/document.xml': '<!DOCTYPE x [<!ENTITY x "boom">]><document>&x;</document>'}))
        self.reject(office(modifications={'word/document.xml': '<!DOCTYPE x><document/>'.encode('utf-16')}))
    def test_plain_text_and_images(self):
        self.check(b'Synthetic personnel note', 'note.txt', 'text/plain')
        self.reject(b'bad\x00text', 'note.txt', 'text/plain')
        self.reject(b'\xffinvalid', 'note.txt', 'text/plain')
        self.reject(b'<html/>', 'page.html', 'text/html')
        from PIL import Image
        output = io.BytesIO(); Image.new('RGB', (10, 10)).save(output, format='PNG')
        self.check(output.getvalue(), 'photo.png', 'image/png')
        self.reject(b'\x89PNG\r\n\x1a\ntruncated', 'photo.png', 'image/png')
    def test_pdf_parser_rejects_actions_and_encryption(self):
        from pypdf import PdfWriter
        from pypdf.generic import NameObject, DictionaryObject, TextStringObject
        def pdf(active=False, encrypted=False):
            writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
            if active: writer._root_object[NameObject('/OpenAction')] = DictionaryObject({NameObject('/S'): NameObject('/JavaScript'), NameObject('/JS'): TextStringObject('app.alert("x")')})
            if encrypted: writer.encrypt('secret')
            out = io.BytesIO(); writer.write(out); return out.getvalue()
        self.check(pdf(), 'tax.pdf', 'application/pdf')
        self.reject(pdf(active=True), 'tax.pdf', 'application/pdf')
        self.reject(pdf(encrypted=True), 'tax.pdf', 'application/pdf')
        self.reject(pdf() + b'PK\x03\x04trailing', 'tax.pdf', 'application/pdf')

class Protocol(unittest.TestCase):
    def test_first_start_refreshes_even_when_host_uptime_is_short(self):
        api = Mock(); api.post.return_value = {'job':None}
        with patch('consumer.Path.read_text', return_value='s'*40), patch('consumer.Path.exists', return_value=False), patch.dict(os.environ, {'PERSONNEL_OPS_ORIGIN':'https://ops-staging.ledgetopdroneservices.com'}), patch('consumer.API', return_value=api), patch('consumer.refresh') as refresh, patch('consumer.time.monotonic', return_value=10), patch('consumer.time.sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt): c.main()
            refresh.assert_called_once()
    def test_pinned_https_and_no_redirect(self):
        for origin in ('http://ops-staging.ledgetopdroneservices.com', 'https://evil.example.test', 'https://ops-staging.ledgetopdroneservices.com/path'):
            with self.assertRaises(ValueError): c.API(origin, 'x' * 40)
        with self.assertRaises(c.Retry): c.NoRedirect().redirect_request(None, None, None, None, None, 'https://evil.example.test')
        api = c.API('https://ops-staging.ledgetopdroneservices.com', 'x' * 40, 'dedicated-id', 'dedicated-secret')
        api.opener = Mock()
        api.open('/api/staff-personnel/scanner/claim', {'workerId': 'test'})
        request = api.opener.open.call_args.args[0]
        self.assertEqual(request.host, 'ops-staging.ledgetopdroneservices.com')
        self.assertEqual(request.get_header('Cf-access-client-secret'), 'dedicated-secret')
        with self.assertRaises(ValueError): api.open('https://evil.example.test')
        with self.assertRaises(ValueError): c.API('https://ops-staging.ledgetopdroneservices.com', 'x'*40, 'id', None)
    def test_engine_outage_and_stale_definitions_never_clean(self):
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%a %b %d %H:%M:%S %Y')
        version = subprocess.CompletedProcess([], 0, f'ClamAV 1.5.0/12345/{stamp}\n')
        with patch('consumer.subprocess.run', return_value=version): self.assertEqual(c.definitions()[0], '1.5.0')
        with patch('consumer.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'ClamAV 1.5.0/1/Mon Jan 01 00:00:00 2001\n')):
            with self.assertRaises(c.Retry): c.definitions()
        with patch('consumer.definitions', return_value=('1.5.0', 'synthetic')):
            for code, expected in ((0, 'clean'), (1, 'rejected')):
                with patch('consumer.subprocess.run', return_value=subprocess.CompletedProcess([], code)):
                    self.assertEqual(c.scan_av(Path('/synthetic'))[0], expected)
            with patch('consumer.subprocess.run', return_value=subprocess.CompletedProcess([], 2)):
                with self.assertRaises(c.Retry): c.scan_av(Path('/synthetic'))
    def test_download_digest_and_size_are_independently_verified(self):
        class Response(io.BytesIO):
            status = 200
            headers = {'X-Document-ETag':'etag', 'X-Document-SHA256':hashlib.sha256(b'abc').hexdigest(), 'X-Document-Version':'opaque-version', 'Content-Length':'3'}
        api = Mock(); api.open.side_effect = lambda *_args, **_kwargs: Response(b'xyz')
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(c.Retry): c.download(api, {'etag':'etag', 'objectVersion':'opaque-version', 'sha256':hashlib.sha256(b'abc').hexdigest(), 'size':3, 'contentPath':'unused', 'leaseToken':'unused'}, Path(root)/'file')

@unittest.skipUnless(os.environ.get('RUN_REAL_CLAMAV_TESTS') == '1', 'Actual ClamAV/definition qualification is a separate explicit gate')
class RealClamAV(unittest.TestCase):
    def test_synthetic_clean_and_eicar_inside_isolated_container(self):
        c.refresh()
        with tempfile.TemporaryDirectory(dir='/work') as root:
            clean = Path(root)/'clean.txt'; clean.write_text('Synthetic clean personnel document')
            self.assertEqual(c.scan_av(clean)[0], 'clean')
            testfile = Path(root)/'antivirus-test.txt'
            testfile.write_bytes(b'X5O!P%@AP[4' + b'\\PZX54(P^)7CC)7}$' + b'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
            self.assertEqual(c.scan_av(testfile)[0], 'rejected')
            nested = b'Synthetic bounded-limit fixture'
            for _ in range(16):
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive: archive.writestr('nested.zip', nested)
                nested = output.getvalue()
            limited = Path(root)/'recursion-limit.zip'; limited.write_bytes(nested)
            self.assertEqual(c.scan_av(limited)[0], 'rejected', 'A recursion-limit skip must never become clean')
            # Join actual validation + download digest + ClamAV + verdict
            # orchestration. The transport is synthetic; the AV is not mocked.
            for source, expected in ((clean, 'clean'), (testfile, 'rejected')):
                data = source.read_bytes()
                job = {'documentId':'11111111-1111-4111-8111-111111111111','leaseToken':'a'*64,'leaseUntil':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=10)).isoformat(),'attempt':1,'filename':'synthetic.txt','contentType':'text/plain','size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'etag':'synthetic-etag','objectVersion':'synthetic-version','policyVersion':c.POLICY}
                for key, suffix in (('contentPath','content'),('receiptPath','receipt'),('retryPath','retry')): job[key]='/api/staff-personnel/scanner/'+job['documentId']+'/'+suffix
                class Response(io.BytesIO):
                    status = 200
                    headers = {'X-Document-ETag':job['etag'],'X-Document-SHA256':job['sha256'],'X-Document-Version':job['objectVersion'],'Content-Length':str(len(data))}
                api = Mock(); api.open.side_effect=lambda *_args, **_kwargs: Response(data); api.post.return_value={'status':'synthetic'}
                c.process_job(api, job)
                receipt = api.post.call_args.args[1]
                self.assertEqual(receipt['verdict'], expected)
                self.assertEqual(receipt['sha256'], hashlib.sha256(data).hexdigest())

if __name__ == '__main__': unittest.main()
