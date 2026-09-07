import re

with open('index.html', 'rb') as f:
    content = f.read()
if content.startswith(b'\xef\xbb\xbf'):
    with open('index.html', 'wb') as f:
        f.write(content[3:])
    print("Fixed BOM in index.html")

