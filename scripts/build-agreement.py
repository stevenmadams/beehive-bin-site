#!/usr/bin/env python3
"""Regenerate workers/form-handler/src/agreement.js from the source markdown.

The agreement a customer signs must be the same words as the document in the
repo, so the customer-facing copy is generated rather than transcribed. Run
this after editing docs/rental-agreement-template.md, and commit both files.

The version stamp changes whenever the text does, which is deliberate: an
acceptance records the version, so you can always answer which wording someone
actually agreed to.
"""
import hashlib, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / 'docs/rental-agreement-template.md').read_text()

# The editorial header, signature block and owner checklist are notes to
# ourselves, not terms; strip them.
body = src.split('## Moving Bin Rental Agreement', 1)[1]
body = body.split('*Owner checklist before first send:*', 1)[0]
body = body.split('**Customer signature:**', 1)[0].rstrip()
body = body.replace('---', '').strip()

# Square Contracts filled these at signing time. We render the agreement
# ourselves, so they become named tokens substituted per rental — a customer
# must never be asked to sign a document with blanks in it.
MERGE = {
    '[10 / 20 / 40 / 60]': '{{BINS}}',
    '[START DATE]': '{{START_DATE}}',
    '[RETURN DATE]': '{{RETURN_DATE}}',
}
for placeholder, token in MERGE.items():
    body = body.replace(placeholder, token)

leftover = re.findall(r'\[[^\]]{1,60}\]', body)
if leftover:
    raise SystemExit(f'unsubstituted placeholder(s) still in the agreement: {leftover}')

version = hashlib.sha256(body.encode()).hexdigest()[:12]

esc = lambda t: t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def inline(t):
    t = esc(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'"([^"]+)"', r'&ldquo;\1&rdquo;', t)
    return t.replace("'", '&rsquo;')

html, buf, in_list = [], [], False

def flush():
    global buf
    if buf:
        html.append('<p>' + inline(' '.join(buf)) + '</p>')
        buf = []

for raw in body.split('\n'):
    line = raw.rstrip()
    if line.startswith('### '):
        flush()
        if in_list:
            html.append('</ul>'); in_list = False
        html.append('<h3>' + inline(line[4:]) + '</h3>')
    elif line.startswith('- '):
        flush()
        if not in_list:
            html.append('<ul>'); in_list = True
        html.append('<li>' + inline(line[2:]) + '</li>')
    elif not line.strip():
        flush()
        if in_list:
            html.append('</ul>'); in_list = False
    else:
        if in_list:
            html[-1] = html[-1][:-5] + ' ' + inline(line.strip()) + '</li>'
        else:
            buf.append(line.strip())

flush()
if in_list:
    html.append('</ul>')

# A plain-text rendering as well: the signed copy goes out as an email, and the
# text part is what survives every client, forward and printout.
text_lines = []
for raw in body.split('\n'):
    line = raw.rstrip()
    if line.startswith('### '):
        text_lines += ['', line[4:].upper(), '']
    elif line.startswith('- '):
        text_lines.append('  * ' + line[2:])
    else:
        text_lines.append(line)
plain = re.sub(r'\*\*(.+?)\*\*', r'\1', '\n'.join(text_lines))
plain = re.sub(r'\n{3,}', '\n\n', plain).strip()

out = '''/* GENERATED — do not edit by hand.
   Source: docs/rental-agreement-template.md
   Regenerate with: python3 scripts/build-agreement.py

   The customer-facing agreement text, and a version stamp derived from it.
   Recording the version alongside each acceptance is what lets you answer, a
   year later, exactly which wording someone agreed to — the text in the repo
   will have moved on by then. */

export const AGREEMENT_VERSION = %s;
export const AGREEMENT_SOURCE_SHA = %s;

export const AGREEMENT_HTML = %s;

export const AGREEMENT_TEXT = %s;

/* Fill the per-rental blanks. Every token must resolve: rendering an agreement
   with a placeholder still showing would put a blank in front of a customer at
   the moment they sign. */
export function renderAgreement(source, values) {
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    const v = values[key];
    if (v === undefined || v === null || v === '') {
      throw new Error(`agreement is missing a value for ${key}`);
    }
    return String(v);
  });
}
''' % (json.dumps(version),
       json.dumps(hashlib.sha256(src.encode()).hexdigest()[:12]),
       json.dumps('\n'.join(html)),
       json.dumps(plain))

(ROOT / 'workers/form-handler/src/agreement.js').write_text(out)
print('agreement version', version, '·', len('\n'.join(html)), 'bytes')
