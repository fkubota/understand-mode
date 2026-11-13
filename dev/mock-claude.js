#!/usr/bin/env node
// テスト用の偽 claude コマンド。server.js の UNDERSTAND_CLAUDE_BIN に指定して使う。
// 指示文に含まれる言葉で、決まった応答を返す。指示文を変えたら、ここの判定語も合わせること。
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] || '';
const sid = 'mock-' + Math.random().toString(36).slice(2, 10);
let text;
if (prompt.includes('実行を承認しました')) {
  text = [
    '実行しました。',
    '```json',
    JSON.stringify({
      columns: ['week', '中央店', '北店', '南店'],
      rows: [['09-01', 540, 410, 380], ['09-08', 560, 400, 390], ['09-15', 550, 420, 400], ['09-22', 570, 430, 410], ['09-29', 610, 470, 450], ['10-06', 650, 500, 480], ['10-13', 820, 530, 500], ['10-20', 680, 540, 510]],
    }),
    '```',
    '```vega-lite',
    JSON.stringify({ data: { name: 'result' }, transform: [{ fold: ['中央店', '北店', '南店'], as: ['店舗', '売上'] }], mark: { type: 'line', point: true }, encoding: { x: { field: 'week', type: 'ordinal', title: '週' }, y: { field: '売上', type: 'quantitative', title: '万円' }, color: { field: '店舗', type: 'nominal' } } }),
    '```',
    '中央店は10月13日の週に跳ねていますが、北店と南店も10月に入ってから伸びています。イベントのない店でも上がっているので、10月の伸びをイベントだけで説明するのは無理がありそうです。',
  ].join('\n');
} else if (prompt.includes('一人称で下書き')) {
  text = 'イベントの寄与が思ったより小さいことは理解できた。\n1. 他店舗も10月に伸びているので、イベントだけが理由という書き方は直してほしい（北店・南店の売上も同じ時期に上がっているため）。\n2. 2日間の290万円には普段どおりの売上も含まれている。上乗せ分で計算し直してほしい。';
} else if (prompt.includes('図で説明')) {
  text = '10月の増加分430万円の内訳で見ると分かりやすいです。\n\n```mermaid\nflowchart LR\n  A[9月 2410万円] --> B[10月 2840万円]\n  B --> C[増加 430万円]\n  C --> D[イベント2日の上乗せ 約107万円]\n  C --> E[残り 約323万円 説明できていない]\n```\n\n2日間の売上290万円のうち、平常どおりなら入るはずの183万円を引くと、イベントの上乗せは約107万円です。増加分の4分の1ほどにとどまります。';
} else if (prompt.includes('データで確かめたい')) {
  text = 'イベントのない他店舗も同じ時期に伸びているかを見れば確かめられます。\n\n```sql\nselect\n    date_trunc(\'week\', d.sales_date) as week\n    , d.shop_id\n    , sum(d.amount) / 10000 as amount_man\nfrom daily_sales d\nwhere d.sales_date >= \'2025-09-01\'\n    and d.sales_date < \'2025-11-01\'\ngroup by 1, 2\norder by 1, 2\n```\n\n中央店だけが跳ねていればイベントの影響と言えますが、他店舗も同じように伸びていれば、季節や別の要因を疑うことになります。\n\n本筋への影響：他店舗と比べずに、中央店の伸びをイベントだけで説明しています。';
} else if (prompt.includes('用語')) {
  text = '**客単価** は「売上 ÷ 客数（レシート枚数）」です。1人あたりいくら買ったかを表します。\n\nこの本筋では、客単価が1,180円から1,340円に上がったことを「普段より多めに買う客層が来た」根拠に使っています。ただし、値上げや商品構成の変化でも上がるので、それだけで客層が変わったとは言い切れません。';
} else {
  text = '中央店の10月の売上が前月より18%増えた、という話です。その理由として、10月12日・13日に近くの公園であった音楽イベントを挙げています。イベント当日の売上が高かったことと、客単価が上がったことの2つを根拠にしています。';
}
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: text, session_id: sid, total_cost_usd: 0 }));
}, 600);
