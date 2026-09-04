#!/usr/bin/env python3
"""
Render ufound_VIDEO_SCRIPT.md as a recording-friendly PDF.

Design goal: this is read aloud while recording, not studied. So the lines that
are SPOKEN are set large in a tinted box, and everything else — stage directions,
what to click — is small and grey so the eye skips it.
"""
import re, sys, html
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, HRFlowable, KeepTogether)

SRC = sys.argv[1] if len(sys.argv) > 1 else "ufound_VIDEO_SCRIPT.md"
OUT = sys.argv[2] if len(sys.argv) > 2 else "ufound_VIDEO_SCRIPT.pdf"
# "big" mode: spoken lines set larger, for a script read aloud live on a call
BIG = len(sys.argv) > 3 and sys.argv[3] == "big"
FOOT = ("ufound AI — inbound booking voice agent · call scripts" if BIG
        else "ufound AI — inbound booking voice agent · recording script")

INK    = colors.HexColor("#1a1a1a")
GREY   = colors.HexColor("#6b6b6b")
ACCENT = colors.HexColor("#0f5c4a")
TINT   = colors.HexColor("#f2f7f5")
RULE   = colors.HexColor("#d8d8d8")

S = {
 "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=20, leading=25,
                      textColor=INK, spaceAfter=2),
 "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=13.5, leading=17,
                      textColor=ACCENT, spaceBefore=16, spaceAfter=7),
 "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=10.2, leading=14,
                      textColor=INK, spaceBefore=11, spaceAfter=4),
 "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9.8, leading=14.5,
                        textColor=GREY, spaceAfter=7, alignment=TA_LEFT),
 # the lines actually spoken — bigger, darker, easy to catch mid-sentence
 "say": ParagraphStyle("say", fontName="Helvetica", fontSize=15 if BIG else 12.4,
                       leading=21.5 if BIG else 18.4,
                       textColor=INK, spaceAfter=9, spaceBefore=1,
                       leftIndent=9, rightIndent=6),
 "bullet": ParagraphStyle("bullet", fontName="Helvetica", fontSize=9.8, leading=14.5,
                          textColor=GREY, spaceAfter=3, leftIndent=13, bulletIndent=3),
 "code": ParagraphStyle("code", fontName="Courier", fontSize=8.4, leading=11.6,
                        textColor=INK, leftIndent=10, spaceBefore=4, spaceAfter=8),
}

def inline(t):
    """markdown inline -> reportlab markup"""
    t = html.escape(t)
    t = re.sub(r"`([^`]+)`", r'<font name="Courier" color="#0f5c4a">\1</font>', t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", t)
    t = t.replace("—", "&#8212;").replace("→", "&#8594;")
    return t

def read_blocks(path):
    """Group the markdown into (kind, lines) blocks, joining wrapped lines."""
    raw = open(path, encoding="utf-8").read().split("\n")
    blocks, buf, kind = [], [], None
    in_fence = False
    def flush():
        nonlocal buf, kind
        if buf: blocks.append((kind, buf))
        buf, kind = [], None
    for ln in raw:
        s = ln.rstrip()
        if s.lstrip().startswith("```"):
            if in_fence: flush()
            else: flush(); kind = "fence"
            in_fence = not in_fence
            continue
        if in_fence:
            buf.append(ln.rstrip("\n"))       # keep indentation and blank lines
            continue
        if not s.strip():
            flush(); continue
        k = ("h1" if s.startswith("# ") else "h3" if s.startswith("### ")
             else "h2" if s.startswith("## ")
             else "hr" if set(s.strip()) == {"-"} and len(s.strip()) >= 3
             else "say" if s.startswith(">")
             else "table" if s.lstrip().startswith("|")
             else "li" if re.match(r"^\s*[-*]\s+", s) else "p")
        # an indented continuation line belongs to the list it follows, not a new para
        if kind == "li" and k == "p" and s.startswith("  "):
            buf.append(s); continue
        if k != kind: flush(); kind = k
        buf.append(s)
    flush()
    return blocks

def say_box(markup):
    """markup is already inline()-converted; <br/> separators must survive escaping."""
    p = Paragraph(markup, S["say"])
    t = Table([[p]], colWidths=[165*mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), TINT),
        ("LINEBEFORE", (0,0), (0,-1), 2.2, ACCENT),
        ("LEFTPADDING", (0,0), (-1,-1), 9), ("RIGHTPADDING", (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 8), ("BOTTOMPADDING", (0,0), (-1,-1), 6),
    ]))
    return t

story = []
for kind, lines in read_blocks(SRC):
    if kind == "h1":
        txt = lines[0][2:].strip()
        if story: story.append(Spacer(1, 16))
        story.append(Paragraph(inline(txt), S["h1"]))
        story.append(HRFlowable(width="100%", thickness=1.6, color=ACCENT,
                                spaceBefore=5, spaceAfter=9))
    elif kind == "h2":
        story.append(KeepTogether([Paragraph(inline(lines[0][3:].strip()), S["h2"])]))
    elif kind == "h3":
        story.append(Paragraph(inline(lines[0][4:].strip()), S["h3"]))
    elif kind == "hr":
        story.append(HRFlowable(width="100%", thickness=0.6, color=RULE,
                                spaceBefore=7, spaceAfter=9))
    elif kind == "say":
        # consecutive "> " lines are one spoken passage; blank "> " = paragraph break
        parts, cur = [], []
        for l in lines:
            body = re.sub(r"^>\s?", "", l)
            if body.strip() == "":
                if cur: parts.append(" ".join(cur)); cur = []
            else:
                cur.append(body.strip())
        if cur: parts.append(" ".join(cur))
        # One box per paragraph. A single tall box cannot split across pages, so
        # long quotes (the email draft) would blow up the layout if joined.
        for i, p in enumerate(parts):
            story.append(say_box(inline(p)))
            if i < len(parts) - 1:
                story.append(Spacer(1, 2))
    elif kind == "li":
        # a bullet may wrap over several source lines; only "- " starts a new one
        items = []
        for l in lines:
            if re.match(r"^\s*[-*]\s+", l):
                items.append(re.sub(r"^\s*[-*]\s+", "", l).strip())
            elif items:
                items[-1] += " " + l.strip()
        for it in items:
            story.append(Paragraph(inline(it), S["bullet"], bulletText="•"))
        story.append(Spacer(1, 4))
    elif kind == "table":
        rows = []
        for l in lines:
            cells = [c.strip() for c in l.strip().strip("|").split("|")]
            if all(set(c) <= set("-: ") and c for c in cells):
                continue                      # the |---|---| separator row
            rows.append(cells)
        if rows:
            ncol = max(len(r) for r in rows)
            rows = [r + [""] * (ncol - len(r)) for r in rows]
            hd = ParagraphStyle("th", parent=S["body"], fontName="Helvetica-Bold",
                                textColor=INK, spaceAfter=0, fontSize=9)
            bd = ParagraphStyle("td", parent=S["body"], spaceAfter=0, fontSize=9,
                                leading=12.5)
            data = [[Paragraph(inline(c), hd if i == 0 else bd) for c in r]
                    for i, r in enumerate(rows)]
            avail = 165*mm
            t = Table(data, colWidths=[avail/ncol]*ncol, hAlign="LEFT")
            t.setStyle(TableStyle([
                ("LINEBELOW", (0,0), (-1,0), 0.9, ACCENT),
                ("LINEBELOW", (0,1), (-1,-2), 0.35, RULE),
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("LEFTPADDING", (0,0), (-1,-1), 0),
                ("RIGHTPADDING", (0,0), (-1,-1), 7),
                ("TOPPADDING", (0,0), (-1,-1), 5),
                ("BOTTOMPADDING", (0,0), (-1,-1), 5),
            ]))
            story.append(t)
            story.append(Spacer(1, 9))
    elif kind == "fence":
        # keep the line breaks and the indentation — it's code, not prose
        esc = [html.escape(l).replace(" ", "&nbsp;") for l in lines]
        story.append(Paragraph("<br/>".join(esc), S["code"]))
        story.append(Spacer(1, 3))
    else:
        story.append(Paragraph(inline(" ".join(l.strip() for l in lines)), S["body"]))

def furniture(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.6)
    canvas.setFillColor(GREY)
    canvas.drawString(22*mm, 12*mm, FOOT)
    canvas.drawRightString(188*mm, 12*mm, f"{doc.page}")
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=22*mm, rightMargin=22*mm,
                      topMargin=18*mm, bottomMargin=20*mm,
                      title="ufound — video recording script", author="Muhammed Yasin")
doc.addPageTemplates([PageTemplate(id="main",
    frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")],
    onPage=furniture)])
doc.build(story)
print(f"wrote {OUT}")
