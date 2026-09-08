"""Durable, private support reports; attachments are never executed or made public."""
from __future__ import annotations
import base64
import binascii
import hashlib
import html
import json
import re
import time

MAX_FILE_SIZE = 20 * 1024 * 1024
MAX_BODY = 29 * 1024 * 1024
MIMES = {'png':'image/png', 'jpg':'image/jpeg', 'jpeg':'image/jpeg', 'gif':'image/gif', 'webp':'image/webp',
         'heic':'image/heic', 'heif':'image/heif', 'mp4':'video/mp4', 'webm':'video/webm', 'mov':'video/quicktime',
         'txt':'text/plain', 'log':'text/plain', 'json':'application/json', 'pdf':'application/pdf',
         'doc':'application/msword', 'docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}

class ReportError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def decode_file(value):
    if value is None: return None
    if not isinstance(value, dict) or not isinstance(value.get('name'), str) or not isinstance(value.get('data'), str):
        raise ReportError('некорректное вложение.')
    name = re.sub(r'[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]', '_', value['name']).strip().strip('.')[:180]
    ext = name.rsplit('.', 1)[-1].lower()
    if ext not in MIMES or not name: raise ReportError('этот формат файла не поддерживается.')
    if len(value['data']) > ((MAX_FILE_SIZE + 2) // 3) * 4: raise ReportError('максимальный размер файла — 20 мб.', 413)
    try: content = base64.b64decode(value['data'], validate=True)
    except (ValueError, binascii.Error): raise ReportError('вложение повреждено.') from None
    if not content or len(content) > MAX_FILE_SIZE or type(value.get('size')) is not int or value['size'] != len(content):
        raise ReportError('размер вложения не совпал или превышает 20 мб.', 413)
    signatures = {'png':b'\x89PNG\r\n\x1a\n', 'jpg':b'\xff\xd8\xff', 'jpeg':b'\xff\xd8\xff', 'gif':b'GIF8',
                  'pdf':b'%PDF-', 'doc':b'\xd0\xcf\x11\xe0', 'docx':b'PK\x03\x04', 'webm':b'\x1aE\xdf\xa3'}
    if ext in signatures and not content.startswith(signatures[ext]): raise ReportError('содержимое файла не соответствует его расширению.')
    if ext == 'webp' and not (content.startswith(b'RIFF') and content[8:12] == b'WEBP'): raise ReportError('некорректное изображение WebP.')
    if ext in ('heic', 'heif', 'mp4') and content[4:8] != b'ftyp': raise ReportError('некорректное изображение или видео.')
    if ext in ('txt', 'log', 'json'):
        try: content.decode('utf-8-sig')
        except UnicodeError: raise ReportError('сохрани текстовый файл в UTF-8.') from None
        if b'\x00' in content: raise ReportError('текстовый файл содержит двоичные данные.')
    return {'name':name, 'mime':MIMES[ext], 'bytes':content, 'size':len(content)}


class Reports:
    def __init__(self, store, admins, quota_bytes=256*1024*1024):
        self.store, self.admins, self.quota_bytes = store, set(admins), quota_bytes
        with store.lock, store.db:
            store.db.execute('''CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY, created_at REAL NOT NULL, message TEXT NOT NULL,
                steps TEXT NOT NULL, expected TEXT NOT NULL, diagnostics TEXT NOT NULL,
                group_name TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL,
                file_name TEXT, file_mime TEXT, file_data BLOB, payload_hash TEXT NOT NULL)''')

    def submit(self, data, author='', author_name=''):
        rid = data.get('report_id')
        if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', rid): raise ReportError('некорректный номер отчёта.')
        limits = {'message':5000, 'steps':2000, 'expected':1000, 'diagnostics':32000, 'group':100}
        for field, limit in limits.items():
            value = data.get(field, '')
            if not isinstance(value, str) or len(value) > limit: raise ReportError('слишком большой или неверный текст отчёта.')
        if not data.get('message', '').strip(): raise ReportError('опиши, что произошло.')
        file = decode_file(data.get('file'))
        fingerprint = hashlib.sha256(json.dumps({k:data.get(k, '') for k in limits}, sort_keys=True, ensure_ascii=False).encode()
            + (file['bytes'] if file else b'') + (file['name'].encode() if file else b'')).hexdigest()
        if not self.admins: raise ReportError('получатель отчётов не настроен.', 503)
        with self.store.lock, self.store.db:
            old = self.store.db.execute('SELECT * FROM reports WHERE id=?', (rid,)).fetchone()
            if old:
                if old['payload_hash'] != fingerprint or old['author'] != author:
                    raise ReportError('этот номер уже принят с другим содержимым. открой новую форму отчёта.', 409)
                return {'ok':True, 'report_id':rid, 'accepted':False, 'duplicate':True, 'attachment_stored':bool(old['file_name'])}
            if self.store.db.execute('SELECT 1 FROM events WHERE id=?', ('report:'+rid+':summary',)).fetchone():
                raise ReportError('этот отчёт уже был принят и удалён. открой новую форму.', 409)
            self.store.db.execute("DELETE FROM reports WHERE created_at<? AND id NOT IN (SELECT report_id FROM outbox WHERE state='pending')", (time.time()-30*86400,))
            used = self.store.db.execute('SELECT COALESCE(SUM(COALESCE(length(file_data),0)+length(diagnostics)+length(message)+length(steps)+length(expected)),0) FROM reports').fetchone()[0]
            required = (file['size'] if file else 0) + sum(len(data.get(k,'').encode()) for k in limits)
            if used + required > self.quota_bytes: raise ReportError('хранилище отчётов заполнено. попробуй позже или отправь текст без файла.', 503)
            self.store.db.execute('INSERT INTO reports VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (rid,time.time(),data['message'].strip(),data.get('steps',''),data.get('expected',''),data.get('diagnostics',''),
                 data.get('group',''),author,author_name,file['name'] if file else None,file['mime'] if file else None,
                 file['bytes'] if file else None,fingerprint))
            esc = lambda value: html.escape(str(value), quote=False)
            text = '<b>🐞 Отчёт № ' + esc(rid[:8]) + '</b>'
            text += '\n<b>Группа:</b> ' + esc(data.get('group') or 'не выбрано')
            text += '\n<b>Автор:</b> ' + esc((author_name + ' · ' + author) if author else 'без подтверждённого входа')
            text += '\n\n<b>Что произошло</b>\n' + esc(data['message'][:2200])
            if data.get('steps'): text += '\n\n<b>Как повторить</b>\n' + esc(data['steps'][:500])
            if data.get('expected'): text += '\n\n<b>Ожидалось</b>\n' + esc(data['expected'][:300])
            parts = [('summary', 'sendMessage', text[:3800])]
            if data.get('diagnostics') or len(data['message']) > 2200 or data.get('steps') or data.get('expected'):
                parts.append(('diagnostics', 'sendDocument', 'полный отчёт и диагностика · № ' + rid[:8]))
            if file: parts.append(('file', 'sendDocument', 'вложение к отчёту № ' + rid[:8]))
            for part, method, text in parts:
                eid = 'report:' + rid + ':' + part
                self.store.db.execute('INSERT INTO events VALUES (?,?)', (eid, time.time()))
                self.store.db.executemany('INSERT INTO outbox(event_id,chat_id,text,method,report_id,part) VALUES (?,?,?,?,?,?)',
                    [(eid,admin,text,method,rid,part) for admin in self.admins])
        return {'ok':True, 'report_id':rid, 'accepted':True, 'duplicate':False, 'attachment_stored':bool(file), 'queued':len(parts)*len(self.admins)}

    def listing(self):
        with self.store.lock:
            rows = self.store.db.execute('SELECT id,created_at,message,steps,expected,diagnostics,group_name,author,author_name,file_name,length(file_data) AS file_size FROM reports ORDER BY created_at DESC LIMIT 50').fetchall()
        return {'ok':True, 'reports':[{'id':r['id'], 'createdAt':int(r['created_at']*1000),
            'message':r['message']+ ('\n\nкак повторить: '+r['steps'] if r['steps'] else '')+ ('\nожидалось: '+r['expected'] if r['expected'] else ''),
            'diagnostics':r['diagnostics'], 'group':r['group_name'], 'by':r['author'], 'byName':r['author_name'],
            'hasFile':bool(r['file_name']), 'fileName':r['file_name'], 'fileSize':r['file_size']} for r in rows]}

    def document(self, rid, part):
        with self.store.lock: r = self.store.db.execute('SELECT * FROM reports WHERE id=?', (rid,)).fetchone()
        if not r: raise ReportError('отчёт не найден.', 404)
        if part == 'file':
            if not r['file_name']: raise ReportError('вложение не найдено.', 404)
            return r['file_name'], r['file_mime'], bytes(r['file_data'])
        text = 'sched · отчёт № '+rid+'\n\n'+r['message']
        # Older reports remain readable; new ones have no empty, removed form fields.
        if r['steps']: text += '\n\nкак повторить: '+r['steps']
        if r['expected']: text += '\nожидалось: '+r['expected']
        if r['diagnostics']: text += '\n\nдиагностика:\n'+r['diagnostics']
        return 'sched-report-'+rid[:8]+'.txt', 'text/plain', text.encode()

    def file_response(self, rid):
        name, mime, data = self.document(rid, 'file')
        return {'ok':True, 'file':{'name':name, 'mime':mime, 'size':len(data), 'data':base64.b64encode(data).decode()}}

    def delete(self, rid):
        with self.store.lock, self.store.db:
            self.store.db.execute("UPDATE outbox SET state='cancelled' WHERE report_id=? AND state='pending'", (rid,))
            self.store.db.execute('DELETE FROM reports WHERE id=?', (rid,))
        return {'ok':True}
