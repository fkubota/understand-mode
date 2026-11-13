#!/usr/bin/env bash
# 「/understand このPRを理解したい」を試すためのサンプルリポジトリを作る。
# main に初版、feature/compare-shops にPR相当の2コミットが乗る。
# 使い方: bash dev/make-pr-demo.sh [作成先(既定 /tmp/understand-pr-demo)]
set -euo pipefail
R="${1:-/tmp/understand-pr-demo}"
rm -rf "$R"; mkdir -p "$R/sales" "$R/tests"; cd "$R"
git init -q -b main
git config user.email demo@example.com
git config user.name demo

cat > sales/totals.py <<'EOF'
"""売上の集計"""


def total_amount(rows):
    """売上の合計を返す。"""
    return sum(r["amount"] for r in rows)


def average_per_receipt(rows):
    """客単価（売上 ÷ レシート枚数）を返す。レシートが0枚なら None。"""
    receipts = sum(r["receipts"] for r in rows)
    return total_amount(rows) / receipts if receipts else None
EOF
cat > sales/report.py <<'EOF'
"""店舗別の売上レポートを作る"""
from collections import defaultdict

from sales.totals import total_amount, average_per_receipt


def build_report(rows):
    by_shop = defaultdict(list)
    for r in rows:
        by_shop[r["shop_id"]].append(r)
    return [
        {"shop_id": s, "amount": total_amount(rs), "per_receipt": average_per_receipt(rs)}
        for s, rs in sorted(by_shop.items())
    ]
EOF
echo 'REPORT_COLUMNS = ["shop_id", "amount", "per_receipt"]' > sales/config.py
cat > tests/test_totals.py <<'EOF'
from sales.totals import average_per_receipt


def test_average_per_receipt():
    rows = [{"amount": 1000, "receipts": 2}, {"amount": 2000, "receipts": 3}]
    assert average_per_receipt(rows) == 600
EOF
git add . && git commit -qm "売上レポートの初版（店舗ごとの売上と客単価）"

git checkout -qb feature/compare-shops
cat >> sales/totals.py <<'EOF'


def growth_rate(current, previous):
    """前月比を返す。前月が0なら None。"""
    prev = total_amount(previous)
    if prev == 0:
        return None
    return total_amount(current) / prev - 1
EOF
git commit -qam "前月比を計算する関数を追加"

cat > sales/config.py <<'EOF'
REPORT_COLUMNS = ["shop_id", "amount", "per_receipt", "growth_rate", "vs_other_shops"]

# この差（ポイント）より大きく他店を上回ったら、その店だけの要因を疑う
OUTLIER_GAP = 0.05
EOF
cat > sales/report.py <<'EOF'
"""店舗別の売上レポートを作る"""
from collections import defaultdict

from sales.totals import total_amount, average_per_receipt, growth_rate
from sales.config import OUTLIER_GAP


def group_by_shop(rows):
    by_shop = defaultdict(list)
    for r in rows:
        by_shop[r["shop_id"]].append(r)
    return by_shop


def build_report(current_rows, previous_rows):
    current, previous = group_by_shop(current_rows), group_by_shop(previous_rows)
    growth = {s: growth_rate(rs, previous.get(s, [])) for s, rs in current.items()}
    known = [g for g in growth.values() if g is not None]
    median = sorted(known)[len(known) // 2] if known else 0

    report = []
    for shop_id, rs in sorted(current.items()):
        g = growth[shop_id]
        report.append({
            "shop_id": shop_id,
            "amount": total_amount(rs),
            "per_receipt": average_per_receipt(rs),
            "growth_rate": g,
            # 他店も同じように伸びているなら、その店だけの要因とは言えない
            "vs_other_shops": None if g is None else g - median,
        })
    return report


def outliers(report):
    """他店より大きく伸びた店だけを返す。"""
    return [r for r in report if (r["vs_other_shops"] or 0) > OUTLIER_GAP]
EOF
cat > tests/test_report.py <<'EOF'
from sales.report import build_report, outliers


def rows(shop, amount):
    return [{"shop_id": shop, "amount": amount, "receipts": 10}]


def test_growth_is_compared_with_other_shops():
    previous = rows("chuo", 100) + rows("kita", 100) + rows("minami", 100)
    current = rows("chuo", 150) + rows("kita", 120) + rows("minami", 120)
    report = build_report(current, previous)
    chuo = next(r for r in report if r["shop_id"] == "chuo")
    assert chuo["growth_rate"] == 0.5
    # 中央店は50%伸びたが、他店も20%伸びているので差は30ポイント
    assert abs(chuo["vs_other_shops"] - 0.3) < 1e-9
    assert [r["shop_id"] for r in outliers(report)] == ["chuo"]
EOF
git add . && git commit -qm "他店と比べた伸びを出し、その店だけの要因かを見分けられるようにする"

echo "作成しました: ${R}（ブランチ feature/compare-shops）"
echo "cd ${R} && claude で開き、/understand このPRを理解したい を試してください。"
