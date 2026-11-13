"""Build an Excel workbook that tracks Claude Code token usage per day and per week.

Usage: python export_excel.py [output.xlsx]     (default: ./out/token-usage.xlsx)

Safe to run repeatedly: every sheet is rebuilt from the transcripts, except "Notes",
which is carried over from the previous file so hand-written notes are never lost.
Requires Node.js (to aggregate the transcripts with server.js) and openpyxl.
"""
import datetime as dt
import json
import os
import subprocess
import sys

from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
N = 5000  # rows of the Data sheet the formulas look at

FONT = "Arial"
F_NORMAL = Font(name=FONT, size=10)
F_TITLE = Font(name=FONT, size=14, bold=True)
F_HEAD = Font(name=FONT, size=10, bold=True, color="FFFFFF")
F_NOTE = Font(name=FONT, size=9, italic=True, color="666666")
F_INPUT = Font(name=FONT, size=10, color="0000FF")
FILL_HEAD = PatternFill("solid", fgColor="3B3A36")
FILL_INPUT = PatternFill("solid", fgColor="FFFF00")
BORDER = Border(bottom=Side(style="thin", color="DDDDDD"))

FMT_INT = '#,##0;-#,##0;"-"'
FMT_USD = '"$"#,##0.00;-"$"#,##0.00;"-"'
FMT_PCT = '0.0%;-0.0%;"-"'
FMT_DATE = "yyyy-mm-dd"


def load_data():
    out = subprocess.run(["node", os.path.join(HERE, "server.js"), "--daily-json"],
                         capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(out.stdout)


def iso_week(day):
    y, w, _ = day.isocalendar()
    return f"{y}-W{w:02d}"


def header(ws, row, titles, widths):
    for i, (t, w) in enumerate(zip(titles, widths), start=1):
        c = ws.cell(row=row, column=i, value=t)
        c.font, c.fill = F_HEAD, FILL_HEAD
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[row].height = 30
    ws.freeze_panes = ws.cell(row=row + 1, column=1)


def style_row(ws, row, formats, font=F_NORMAL):
    for i, f in enumerate(formats, start=1):
        c = ws.cell(row=row, column=i)
        c.font, c.border = font, BORDER
        if f:
            c.number_format = f


def previous_notes(path):
    if not os.path.exists(path):
        return []
    try:
        wb = load_workbook(path)
    except Exception:
        return []
    if "Notes" not in wb.sheetnames:
        return []
    return [(d, n) for d, n in wb["Notes"].iter_rows(min_row=4, max_col=2, values_only=True) if d is not None or n]


def style_chart(chart):
    chart.roundedCorners = False
    chart.legend.position = "b"
    chart.legend.overlay = False
    chart.title.overlay = False
    chart.x_axis.delete = False
    chart.y_axis.delete = False
    chart.height, chart.width = 8, 20


def build(path):
    data = load_data()
    rows = data["rows"]
    cal = data.get("cal") or {}
    weekly_pct = (cal.get("week") or {}).get("pctPerDollar")
    notes = previous_notes(path)

    # Agents with their own cost column: the main session plus the most used subagents.
    by_agent = {}
    for r in rows:
        by_agent[r["agent"]] = by_agent.get(r["agent"], 0) + r["cost"]
    agents = ["main"] + [a for a, _ in sorted(by_agent.items(), key=lambda x: -x[1]) if a != "main"][:3]

    wb = Workbook()
    wb.remove(wb.active)

    # ---------- Settings ----------
    st = wb.create_sheet("Settings")
    st["A1"], st["A1"].font = "Settings", F_TITLE
    st.column_dimensions["A"].width = 46
    st.column_dimensions["B"].width = 14
    st.column_dimensions["C"].width = 72
    st["A3"], st["A3"].font = "% of the weekly plan limit per equivalent $", F_NORMAL
    st["B3"] = (weekly_pct or 0) / 100
    st["B3"].font, st["B3"].fill, st["B3"].number_format = F_INPUT, FILL_INPUT, "0.000%"
    st["C3"] = ("From the dashboard calibration (Claude app usage card). Leave 0 if you are on the API "
                "or have not calibrated; edit it by hand if you know a better value.")
    st["C3"].font = F_NOTE
    st["A5"] = ("Legend: yellow cells with blue text are inputs. Everything else is calculated and rebuilt on "
                "every export. Write your own comments in the Notes sheet: it is preserved.")
    st["A5"].font = F_NOTE
    st["A6"] = f"Last export: {dt.datetime.now():%Y-%m-%d %H:%M}. Costs use the prices in pricing.json."
    st["A6"].font = F_NOTE
    PCT = "Settings!$B$3"

    # ---------- Data ----------
    da = wb.create_sheet("Data")
    header(da, 1, ["Date", "Week", "Agent", "Model", "Responses", "Input", "Output", "Cache writes", "Cache reads",
                   "Usage (tokens)", "Equivalent cost ($)", "Cost if all were Opus ($)", "Calls over tier",
                   "Max context (tokens)"], [12, 10, 16, 10, 11, 11, 11, 13, 14, 15, 14, 16, 12, 14])
    fmts = [FMT_DATE, None, None, None, FMT_INT, FMT_INT, FMT_INT, FMT_INT, FMT_INT, FMT_INT, FMT_USD, FMT_USD, FMT_INT, FMT_INT]
    days = []
    for i, r in enumerate(rows, start=2):
        d = dt.date.fromisoformat(r["day"])
        days.append(d)
        vals = [d, iso_week(d), r["agent"], r["family"], r["calls"], r["inp"], r["out"], r["cw"], r["cr"],
                f"=F{i}+G{i}+H{i}", round(r["cost"], 6), round(r["asOpus"], 6), r["overTier"], r["maxPrompt"]]
        for j, v in enumerate(vals, start=1):
            da.cell(row=i, column=j, value=v)
        style_row(da, i, fmts)
    da.auto_filter.ref = f"A1:N{max(2, len(rows) + 1)}"
    da["J1"].comment = Comment("Usage = input + output + cache writes. Cache reads are reused context, billed far cheaper.", "token-monitor")
    da["L1"].comment = Comment("What the same tokens would cost at Opus prices. The difference is the saving from delegating.", "token-monitor")
    rng = lambda col: f"Data!${col}$2:${col}${N}"

    # ---------- Daily ----------
    dy = wb.create_sheet("Daily", 0)
    dy["A1"], dy["A1"].font = "Daily usage", F_TITLE
    dy["A2"] = "Weekly limit % = equivalent cost × the Settings value. It is an estimate."
    dy["A2"].font = F_NOTE
    cols = ["Date", "Weekday", "Responses", "Usage (tokens)", "Cache reads", "Equivalent cost ($)", "% of weekly limit (est.)"]
    cols += [f"Cost {a} ($)" for a in agents] + ["Cost other agents ($)", "Saved by Haiku ($)"]
    header(dy, 4, cols, [12, 11, 11, 15, 14, 14, 14] + [15] * len(agents) + [14, 13])
    unique_days = sorted(set(days))
    first_agent_col = 8
    other_col = first_agent_col + len(agents)
    for i, d in enumerate(unique_days, start=5):
        q = f"{rng('A')},$A{i}"
        dy.cell(row=i, column=1, value=d)
        dy.cell(row=i, column=2, value=d.strftime("%A"))
        dy.cell(row=i, column=3, value=f"=SUMIFS({rng('E')},{q})")
        dy.cell(row=i, column=4, value=f"=SUMIFS({rng('J')},{q})")
        dy.cell(row=i, column=5, value=f"=SUMIFS({rng('I')},{q})")
        dy.cell(row=i, column=6, value=f"=SUMIFS({rng('K')},{q})")
        dy.cell(row=i, column=7, value=f"=F{i}*{PCT}")
        for j, a in enumerate(agents, start=first_agent_col):
            dy.cell(row=i, column=j, value=f'=SUMIFS({rng("K")},{q},{rng("C")},"{a}")')
        first, lastc = get_column_letter(first_agent_col), get_column_letter(other_col - 1)
        dy.cell(row=i, column=other_col, value=f"=ROUND(F{i}-SUM({first}{i}:{lastc}{i}),6)")
        dy.cell(row=i, column=other_col + 1, value=f'=SUMIFS({rng("L")},{q},{rng("D")},"Haiku")-SUMIFS({rng("K")},{q},{rng("D")},"Haiku")')
        style_row(dy, i, [FMT_DATE, None, FMT_INT, FMT_INT, FMT_INT, FMT_USD, FMT_PCT] + [FMT_USD] * (len(agents) + 2))
    last_day = 4 + len(unique_days)
    if unique_days:
        ch = BarChart()
        ch.type, ch.grouping, ch.overlap = "col", "stacked", 100
        ch.title = "Equivalent cost per day and agent ($)"
        ch.add_data(Reference(dy, min_col=first_agent_col, max_col=other_col, min_row=4, max_row=last_day), titles_from_data=True)
        ch.set_categories(Reference(dy, min_col=1, min_row=5, max_row=last_day))
        style_chart(ch)
        dy.add_chart(ch, f"A{last_day + 3}")

    # ---------- Weekly ----------
    wk = wb.create_sheet("Weekly", 0)
    wk["A1"], wk["A1"].font = "Weekly summary", F_TITLE
    wk["A2"] = "ISO weeks (Monday to Sunday). Plan limits may reset on another weekday: the % is this week's spend expressed as a share of the weekly limit."
    wk["A2"].font = F_NOTE
    header(wk, 4, ["Week", "From", "To", "Responses", "Usage (tokens)", "Equivalent cost ($)", "% of weekly limit (est.)",
                   "Opus cost ($)", "Haiku cost ($)", "Other models ($)", "Share of responses by Haiku",
                   "Saved by Haiku ($)", "Calls over tier"], [11, 12, 12, 11, 15, 14, 14, 13, 13, 14, 15, 13, 12])
    weeks = sorted({iso_week(d) for d in days})
    for i, w in enumerate(weeks, start=5):
        y, n = w.split("-W")
        monday = dt.date.fromisocalendar(int(y), int(n), 1)
        q = f"{rng('B')},$A{i}"
        vals = [w, monday, monday + dt.timedelta(days=6),
                f"=SUMIFS({rng('E')},{q})", f"=SUMIFS({rng('J')},{q})", f"=SUMIFS({rng('K')},{q})", f"=F{i}*{PCT}",
                f'=SUMIFS({rng("K")},{q},{rng("D")},"Opus")', f'=SUMIFS({rng("K")},{q},{rng("D")},"Haiku")',
                f"=ROUND(F{i}-H{i}-I{i},6)",
                f'=IF(D{i}=0,0,SUMIFS({rng("E")},{q},{rng("D")},"Haiku")/D{i})',
                f'=SUMIFS({rng("L")},{q},{rng("D")},"Haiku")-I{i}', f"=SUMIFS({rng('M')},{q})"]
        for j, v in enumerate(vals, start=1):
            wk.cell(row=i, column=j, value=v)
        style_row(wk, i, [None, FMT_DATE, FMT_DATE, FMT_INT, FMT_INT, FMT_USD, FMT_PCT, FMT_USD, FMT_USD, FMT_USD, FMT_PCT, FMT_USD, FMT_INT])
    last_week = 4 + len(weeks)
    if weeks:
        t = last_week + 1
        wk.cell(row=t, column=1, value="Total")
        for c in (4, 5, 6, 8, 9, 10, 12, 13):
            L = get_column_letter(c)
            wk.cell(row=t, column=c, value=f"=SUM({L}5:{L}{last_week})")
        style_row(wk, t, [None, None, None, FMT_INT, FMT_INT, FMT_USD, None, FMT_USD, FMT_USD, FMT_USD, None, FMT_USD, FMT_INT],
                  Font(name=FONT, size=10, bold=True))
        ch = BarChart()
        ch.type, ch.grouping, ch.overlap = "col", "stacked", 100
        ch.title = "Equivalent cost per week and model ($)"
        ch.add_data(Reference(wk, min_col=8, max_col=10, min_row=4, max_row=last_week), titles_from_data=True)
        ch.set_categories(Reference(wk, min_col=1, min_row=5, max_row=last_week))
        style_chart(ch)
        wk.add_chart(ch, f"A{t + 3}")

    # ---------- Notes (preserved between exports) ----------
    no = wb.create_sheet("Notes")
    no["A1"], no["A1"].font = "Notes", F_TITLE
    no["A2"] = "Write anything worth remembering per day. This sheet is kept when you export again."
    no["A2"].font = F_NOTE
    header(no, 3, ["Date", "Note"], [12, 100])
    if not notes:
        notes = [(dt.date.today(), "Example: first day using the orchestra workflow.")]
    for i, (d, n) in enumerate(notes, start=4):
        no.cell(row=i, column=1, value=d).number_format = FMT_DATE
        no.cell(row=i, column=2, value=n)
        no.cell(row=i, column=1).font = no.cell(row=i, column=2).font = F_INPUT

    wb.calculation.fullCalcOnLoad = True
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    try:
        wb.save(path)
    except PermissionError:
        print(f"Could not save {path}: close it in Excel and try again.")
        sys.exit(1)
    print(f"Workbook updated: {path} ({len(unique_days)} days, {len(weeks)} weeks, {len(rows)} data rows)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "out", "token-usage.xlsx"))
