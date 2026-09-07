import re

with open('js/app.js', 'r', encoding='utf-8') as f:
    app_js = f.read()

# 1. Swipes on phone prevent default
app_js = re.sub(
    r'(scene\.addEventListener\(\s*"touchmove",\s*\(e\) => \{.*?)if \(swipe\.axis !== "x"\) return;',
    r'\1if (swipe.axis === "x" && e.cancelable) e.preventDefault();\n      if (swipe.axis !== "x") return;',
    app_js, flags=re.DOTALL
)
app_js = re.sub(
    r'(scene\.addEventListener\(\s*"touchmove".*?),\s*\{\s*passive:\s*true\s*\}\s*\);',
    r'\1, { passive: false });',
    app_js, flags=re.DOTALL
)

# 2. Pair animation
app_js = re.sub(
    r'selectDate\(new Date\(([^)]+)\)\);',
    r'const newDate = new Date(\1);\n    const dir = newDate > state.selected ? "forward" : (newDate < state.selected ? "backward" : null);\n    selectDate(newDate, dir);',
    app_js
)

# 3. Remove "заявки и редакторы" from profile only
to_remove = r'''canReview\s*\?\s*`<button class="weekly-settings-row" type="button" data-act="open-tg">\s*<span class="weekly-settings-row-main">\s*<span class="weekly-settings-icon is-editor">\$\{ICON_SHIELD\}</span>\s*<span class="weekly-settings-copy">\s*<strong>заявки и редакторы</strong>\s*<span>\$\{pendingCount \? "ждут проверки: " \+ pendingCount : "проверка замен и права"\}</span>\s*</span>\s*</span>\s*\$\{ICON_CHEVRON\}\s*</button>`\s*:\s*""'''
app_js = re.sub(to_remove, '""', app_js)

# 4. Accent+ keeps its state
app_js = re.sub(
    r'if \(state\.palette !== "accent"\) state\.palette = "accent";',
    r'if (state.palette !== "accent" && state.palette !== "accent-plus") state.palette = "accent";',
    app_js
)

# 7. Initially group unselected
app_js = re.sub(
    r'state\.group = GROUPS\.some\(\(g\) => g\.id === DEFAULT_GROUP\) \? DEFAULT_GROUP : \(GROUPS\[0\] \? GROUPS\[0\]\.id : DEFAULT_GROUP\);',
    r'state.group = "";',
    app_js
)

with open('js/app.js', 'w', encoding='utf-8') as f:
    f.write(app_js)
