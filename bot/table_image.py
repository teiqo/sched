"""Renders schedule day tables to PNG bytes matching media_1789279882554.png."""
from __future__ import annotations

import io
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# Path to bundled Inter font
FONT_PATH = Path(__file__).resolve().parents[1] / "public/assets/fonts/inter.ttf"

def render_schedule_table(day_name: str, rows: list[dict]) -> bytes:
    """
    Renders a schedule table matching media_1789279882554.png.
    - day_name: e.g. 'четверг'
    - rows: list of dicts:
        [{ 'n': 1, 'subject': '...', 'teacher_room': '...', 'time': '8:30–10:05' }, ...]
    Returns: PNG bytes
    """
    bg_color = (60, 68, 83, 255)         # #3c4453
    border_color = (82, 94, 114, 255)     # #525e72
    grid_color = (74, 86, 105, 255)       # #4a5669
    header_text_color = (227, 230, 233, 255) # #e3e6e9
    cell_text_color = (220, 224, 230, 255)   # #dce0e6

    # Load font
    font_title = None
    font_header = None
    font_cell = None
    if FONT_PATH.exists():
        try:
            font_title = ImageFont.truetype(str(FONT_PATH), 15)
            font_header = ImageFont.truetype(str(FONT_PATH), 13)
            font_cell = ImageFont.truetype(str(FONT_PATH), 12)
        except Exception:
            pass

    if not font_cell:
        for p in [
            'C:\\Windows\\Fonts\\segoeui.ttf',
            'C:\\Windows\\Fonts\\arial.ttf',
            'C:\\Windows\\Fonts\\calibri.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
        ]:
            if os.path.exists(p):
                try:
                    font_title = ImageFont.truetype(p, 15)
                    font_header = ImageFont.truetype(p, 13)
                    font_cell = ImageFont.truetype(p, 12)
                    break
                except Exception:
                    pass

    if not font_cell:
        font_title = ImageFont.load_default()
        font_header = font_title
        font_cell = font_title

    width = 320
    margin_x = 10
    top_title_h = 32
    table_w = width - margin_x * 2  # 300px
    radius = 8

    # Column widths matching media_1789279882554.png
    col_w_num = 20
    col_w_subj = 100
    col_w_meta = 98
    col_w_time = 82

    col_x_num = margin_x
    col_x_subj = col_x_num + col_w_num
    col_x_meta = col_x_subj + col_w_subj
    col_x_time = col_x_meta + col_w_meta

    def wrap_text(text: str, max_w: int, font: ImageFont.ImageFont) -> list[str]:
        if not text:
            return []
        words = text.split()
        lines = []
        cur = ""
        for w in words:
            test = f"{cur} {w}".strip()
            bbox = font.getbbox(test)
            if bbox[2] - bbox[0] <= max_w:
                cur = test
            else:
                if cur:
                    lines.append(cur)
                    cur = ""
                w_bbox = font.getbbox(w)
                if w_bbox[2] - w_bbox[0] > max_w:
                    part = ""
                    for ch in w:
                        test_part = part + ch
                        p_bbox = font.getbbox(test_part)
                        if p_bbox[2] - p_bbox[0] <= max_w:
                            part = test_part
                        else:
                            if part:
                                lines.append(part)
                            part = ch
                    cur = part
                else:
                    cur = w
        if cur:
            lines.append(cur)
        return lines

    header_subj_lines = wrap_text("предмет", col_w_subj - 10, font_header)
    header_meta_lines = ["преподавате", "ль / ауд."]
    header_h = 42

    row_data = []
    total_table_h = header_h
    for r in rows:
        n_str = str(r.get('n', ''))
        subj = str(r.get('subject') or '').strip()
        meta = str(r.get('teacher_room') or '').strip()
        time_str = str(r.get('time') or '').strip()

        subj_lines = wrap_text(subj, col_w_subj - 10, font_cell)
        meta_lines = wrap_text(meta, col_w_meta - 10, font_cell)

        lines_count = max(1, len(subj_lines), len(meta_lines))
        row_h = max(36, lines_count * 16 + 14)
        row_data.append({
            'n': n_str,
            'subj_lines': subj_lines,
            'meta_lines': meta_lines,
            'time': time_str,
            'h': row_h
        })
        total_table_h += row_h

    total_h = top_title_h + total_table_h + 12

    img = Image.new('RGBA', (width, total_h), bg_color)
    draw = ImageDraw.Draw(img)

    # Title: day_name centered
    title_bbox = font_title.getbbox(day_name)
    title_w = title_bbox[2] - title_bbox[0]
    draw.text(((width - title_w) // 2, 8), day_name, fill=header_text_color, font=font_title)

    # Table rounded border
    table_top = top_title_h
    table_bottom = table_top + total_table_h
    draw.rounded_rectangle(
        [margin_x, table_top, margin_x + table_w, table_bottom],
        radius=radius,
        outline=border_color,
        width=1
    )

    # Header texts
    draw.text((col_x_num + 7, table_top + 13), "#", fill=header_text_color, font=font_header)

    y_cur = table_top + 13
    for l in header_subj_lines:
        draw.text((col_x_subj + 7, y_cur), l, fill=header_text_color, font=font_header)
        y_cur += 16

    y_cur = table_top + 5
    for l in header_meta_lines:
        draw.text((col_x_meta + 7, y_cur), l, fill=header_text_color, font=font_header)
        y_cur += 16

    draw.text((col_x_time + 7, table_top + 13), "время", fill=header_text_color, font=font_header)

    # Header bottom horizontal line
    cur_y = table_top + header_h
    draw.line([(margin_x, cur_y), (margin_x + table_w, cur_y)], fill=grid_color, width=1)

    # Draw rows
    for item in row_data:
        draw.text((col_x_num + 7, cur_y + 10), item['n'], fill=cell_text_color, font=font_cell)

        y_s = cur_y + 8
        for l in item['subj_lines']:
            draw.text((col_x_subj + 7, y_s), l, fill=cell_text_color, font=font_cell)
            y_s += 16

        y_m = cur_y + 8
        for l in item['meta_lines']:
            draw.text((col_x_meta + 7, y_m), l, fill=cell_text_color, font=font_cell)
            y_m += 16

        draw.text((col_x_time + 6, cur_y + 10), item['time'], fill=cell_text_color, font=font_cell)

        cur_y += item['h']
        if cur_y < table_bottom:
            draw.line([(margin_x, cur_y), (margin_x + table_w, cur_y)], fill=grid_color, width=1)

    # Vertical grid lines
    for col_x in [col_x_subj, col_x_meta, col_x_time]:
        draw.line([(col_x, table_top), (col_x, table_bottom)], fill=grid_color, width=1)

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()
