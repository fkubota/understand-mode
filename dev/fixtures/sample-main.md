# 中央店の10月の売上が伸びた理由

結論から言うと、10月12日・13日に近くの公園で開かれた音楽イベントの影響です。

中央店の10月の売上は2,840万円で、前月比18%増でした。日別に見ると12日と13日が突出していて、この2日間だけで290万円を売り上げています。イベントの来場者が立ち寄ったものと考えられます。

客単価も1,180円から1,340円に上がっていて、普段より多めに買う客層が来たことを裏づけています。

## 次のアクション案

1. 来年の同じ時期は、12日前後の在庫を1.5倍に積む
2. イベント開催日に合わせた販促を定例化する

## 該当するコード

~~~~sql analytics/daily_sales.sql:6
select
    d.sales_date
    , sum(d.amount) as amount
    , count(distinct d.receipt_id) as receipts
from daily_sales d
where d.shop_id = 'chuo'
group by 1
order by 1
~~~~
