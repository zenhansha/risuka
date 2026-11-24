# Orbit

[![test](https://github.com/zenhansha/risuka/actions/workflows/test.yml/badge.svg)](https://github.com/zenhansha/risuka/actions/workflows/test.yml)

サーバーの中で本物のブラウザ(Chromium)を動かして、その**画面だけ**を手元に送る、招待制の匿名ブラウザです。

- 見に行ったサイトに見えるのは**サーバーの IP**。あなたの IP は届きません
- サイトの JavaScript は**サーバーの中だけ**で動きます。手元に届くのは JPEG の画面だけです
- 接続を切ると、Cookie・キャッシュ・履歴は**全部消えます**。見た URL はサーバーに記録しません
- 広告とアクセス解析のドメイン、サーバー内部へのアクセスはブロックします

使えるのは、管理人が**承認した ID とパスワード**を持っている人だけです。

## 使い方

入口は、わざと CSS なしの素っ気ないページです。

```
go
[id      ]
[password] [→]
申請
[id      ]
[password] [→]
```

1. **申請**に、自分で決めた ID とパスワードを入れて → を押す。`success` と出れば申請完了
2. 管理人にメールが届き、メールのボタンから承認する
3. **go** に同じ ID とパスワードを入れて → を押すと、ボタンからピクセルの波紋が広がって、向こう側に入ります
4. 向こう側には URL を入れる欄だけ。URL か検索ワード(Startpage で検索)を入れると、欄が上に移動してページが現れます

| 操作 | やり方 |
|---|---|
| アドレス欄に移動 | `Ctrl` + `L` |
| 新しいタブ | `Ctrl` + `T` または ＋ |
| タブの切り替え | 上のタブ(スマホでは `1/2` のボタン) |
| 文字のコピー | ページで選んで `Ctrl` + `C` |
| 貼り付け | `Ctrl` + `V` |
| 終了して全部消す | 右上の電源ボタン |

日本語入力もそのまま使えます。

## しくみ

```
[GitHub Pages]  index.html / assets/     ← 入口と向こう側の画面
      │  HTTPS / WebSocket
      ▼
[Oracle Cloud の無料サーバー]
  Caddy(HTTPS を自動設定、アクセスログなし)
   └ Orbit サーバー(server/)
       ├ /api/apply      申請 → Resend で管理人にメール
       ├ /api/login      ID とパスワードの確認 → 承認済みならトークンを発行
       ├ /admin/review   メールから開く承認ページ
       ├ /ws             画面と入力のやり取り
       └ Chromium(人ごとに使い捨てのシークレットウィンドウ)
            └ すべての通信は「出口の番人」(server/src/guard.js)を通る
                 ・内部アドレス(127.0.0.1、10.x、169.254.169.254 など)を拒否
                 ・メールやデータベースのポートを拒否
                 ・トラッカーを拒否
```

### ID とパスワード

- **ID**: 3〜24 文字。英数字と `-` `_` `.` だけ。大文字と小文字は区別しません。ほかの人と同じ ID は使えません
- **パスワード**: 8 文字以上(日本語も可)。ID を含むものと、同じ文字だけのものは使えません
- パスワードは **scrypt(ソルト付き)のハッシュだけ**を保存します。データが漏れてもパスワードは分かりません。承認メールにもパスワードは書かれません
- 「ID が存在しない」と「パスワードが違う」は同じ答え(`ID かパスワードが違います`)を返すので、ID の有無を探られません
- パスワードを **10 回間違えるとその ID は 15 分ロック**されます(IP を変えても同じ)
- パスワードを忘れたときの再設定はありません。別の ID で申請し直してください

### 承認

1. 申請があると、管理人に ID と申請日時が書かれたメールが届きます
2. メールのボタンを押すと確認ページが開き、そこで「承認する」を押すと使えるようになります
   - リンクを開いただけでは承認されません(メールソフトが勝手にリンクを開くことがあるため)
   - 承認したあとでも、同じページから「利用を止める」ができます。使用中なら即座に切断されます
3. ログインすると 12 時間有効なトークンが発行されます

### 管理画面

メールの承認リンクとは別に、ブラウザから使える管理画面もあります。`.env` に `ORBIT_ADMIN_ID` と `ORBIT_ADMIN_PASSWORD` を入れておくと、その ID とパスワードで **go** から入ったとき、ブラウザではなく**管理画面**が開きます。

- **申請・利用者**: 一覧から承認・却下・停止・削除。いま接続中の人には「切断」も
- **いま使っている人**: 接続中のセッションを見て、強制切断
- **管理者**: 管理者を追加・削除(メインの管理者=環境変数のものは削除不可)
- **設定**: タブ数、無操作で終了するまでの時間、1回の最大時間、パスワードの最低文字数などを、その場で変更(再起動なしで反映され、保存もされます)

管理者のパスワードは `.env`(サーバーの中だけ)にあり、公開リポジトリには残りません。追加した管理者のパスワードは scrypt のハッシュで保存されます。管理者 ID と利用者 ID は別の名前空間ではなく、同じ名前は両方には使えません。

### 上限(`deploy/.env` で変えられます)

| 項目 | 初期値 | 設定名 |
|---|---|---|
| 1 人あたりのタブ | 3 | `ORBIT_TABS_PER_USER` |
| 全体のタブ | 10 | `ORBIT_TABS_TOTAL` |
| 操作がないと終了 | 10 分 | `ORBIT_IDLE_MINUTES` |
| 1 回のセッション | 60 分 | `ORBIT_SESSION_MINUTES` |
| パスワードの最低文字数 | 8 | `ORBIT_PASSWORD_MIN_LENGTH` |
| 申請 | 1 つの IP から 1 時間に 3 回 | `ORBIT_APPLY_PER_HOUR` |
| 審査待ちの申請 | 30 件まで | `ORBIT_PENDING_MAX` |

## 公開のしかた(全部無料・全部クラウド)

使うもの: GitHub Pages(画面)、Oracle Cloud の Always Free(サーバー)、DuckDNS(無料のドメイン)、Resend(メール)。パソコンがなくても、ブラウザだけで全部できます。

### 1. Resend(承認メール)

1. https://resend.com に**管理人のメールアドレス**で登録
2. 「API Keys」でキーを作ってメモ(`re_` で始まる文字列)
3. 送信元は最初から使える `onboarding@resend.dev` のままで大丈夫です。ただしこの送信元は **Resend に登録したアドレスにしか送れない**ので、`ORBIT_OWNER_EMAIL` にはそのアドレスを入れてください

### 2. Oracle Cloud(サーバー)

> ⚠️ **請求されないために**: 作るのは **VM.Standard.A1.Flex(Ampere)だけ**。作成画面に「Always Free 対象」と出ていることを確認してください。E5 などほかのシェイプは有料です。リージョンはホーム(東京)のまま。念のため「請求 → 予算」で 1 円のアラートも作っておくと安心です。

1. コンソール右上の **Cloud Shell**(ブラウザの中で動くターミナル)を開いて、SSH の鍵を作る

   ```bash
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/orbit && cat ~/.ssh/orbit.pub
   ```

   表示された `ssh-ed25519 ...` の 1 行をコピーしておきます
2. 「コンピュート → インスタンス → インスタンスの作成」
   - イメージ: **Ubuntu 24.04**(aarch64)
   - シェイプ: **VM.Standard.A1.Flex**、OCPU 2〜4、メモリ 8〜24 GB(その時点の無料枠の範囲で)
   - SSH キー: 「公開キーの貼付け」に、さっきコピーした 1 行を貼る
   - 「容量不足(Out of capacity)」と出たら、時間をおいて何度か試してください
3. インスタンスのサブネット → セキュリティ・リスト → イングレス・ルールに追加
   - ソース `0.0.0.0/0`、TCP、宛先ポート `80`
   - ソース `0.0.0.0/0`、TCP、宛先ポート `443`
4. インスタンスのパブリック IP をメモ

### 3. DuckDNS(無料のドメイン)

1. https://www.duckdns.org にログインして、好きな名前(例 `my-orbit`)を作る
2. 「current ip」に Oracle のパブリック IP を入れて「update ip」

### 4. サーバーで Orbit を起動

Cloud Shell からインスタンスに入ります(`パブリックIP` は自分のものに置き換え):

```bash
ssh -i ~/.ssh/orbit ubuntu@パブリックIP
```

入れたら、セットアップを実行:

```bash
curl -fsSL https://raw.githubusercontent.com/zenhansha/risuka/main/deploy/setup-oracle.sh -o setup-oracle.sh && bash setup-oracle.sh
```

設定ファイルを開いて、`ORBIT_DOMAIN`、`ORBIT_PUBLIC_URL`、`ORBIT_OWNER_EMAIL`、`RESEND_API_KEY` を入れて保存(`Ctrl` + `O` → `Enter` → `Ctrl` + `X`):

```bash
nano ~/orbit/deploy/.env
```

起動:

```bash
cd ~/orbit/deploy && sudo docker compose up -d --build
```

`https://(DuckDNS の名前).duckdns.org/api/health` を開いて `{"ok":true,...}` が出れば成功です。

### 5. 画面(GitHub Pages)をサーバーにつなぐ

GitHub で `assets/config.js` を開き、鉛筆マークから `apiBase` にサーバーの URL を入れてコミットします。

```js
window.ORBIT_CONFIG = {
  apiBase: "https://my-orbit.duckdns.org",
};
```

数分で https://zenhansha.github.io/risuka/ に反映されます(Settings → Pages が「Deploy from a branch」「main」「/ (root)」になっていること)。

### 更新するとき

```bash
cd ~/orbit && git pull && cd deploy && sudo docker compose up -d --build
```

### 困ったとき

```bash
cd ~/orbit/deploy && sudo docker compose logs --tail 100 orbit
```

| 症状 | 原因と対処 |
|---|---|
| 入口で「サーバーにつながりません」 | `assets/config.js` の `apiBase` が空か間違い。または `ORBIT_ALLOWED_ORIGINS` に `https://zenhansha.github.io` が入っていない |
| `/api/health` が開かない | セキュリティ・リストの 80/443、DuckDNS の IP、`ORBIT_DOMAIN` を確認 |
| 承認メールが来ない | `RESEND_API_KEY` と `ORBIT_OWNER_EMAIL`(Resend に登録したアドレス)を確認。迷惑メールフォルダも |
| 「サーバーが混んでいます」 | 全体のタブ数の上限。`ORBIT_TABS_TOTAL` を増やすか、メモリを増やす |

## 手元で動かす(開発用)

Node.js 20 以上が必要です。

```bash
cd server && npm install && npx playwright install chromium
```

```bash
npm run dev
```

http://localhost:8080 を開きます。開発モードではメールを送らず、承認リンクをターミナルに表示します。`localhost` のページも開けるようになっているので、**公開サーバーでは絶対に `ORBIT_DEV` と `ORBIT_ALLOW_PRIVATE` を使わないでください**。

テスト(GitHub に push すると自動でも走ります):

```bash
cd server && npm test
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 入口(CSS なし)と、向こう側の画面、管理画面 |
| `assets/world.css`, `assets/app.js` | 向こう側の見た目、ピクセルの波紋、リモート画面の操作 |
| `assets/admin.css`, `assets/admin.js` | 管理画面 |
| `assets/config.js` | サーバーの URL |
| `server/src/index.js` | 起動 |
| `server/src/app.js` | API、承認ページ、WebSocket |
| `server/src/browser.js` | Chromium のセッションとタブ、画面の配信、入力の再現 |
| `server/src/guard.js` | 出口の番人(内部アドレス・危険なポート・トラッカーを拒否) |
| `server/src/trackers.js` | ブロックするトラッカーの一覧 |
| `server/src/ids.js` | ID とパスワードのチェック、パスワードのハッシュ、署名、トークン |
| `server/src/store.js` | 申請データ(JSON ファイル 1 つ) |
| `server/src/mailer.js`, `html.js` | 承認メールと承認ページ |
| `server/test/` | テスト |
| `deploy/` | Docker Compose、Caddy、Oracle 用のセットアップ |
| `.github/workflows/test.yml` | push のたびにテストと Docker のビルドを確認 |

## 注意

- ログインしたサイトには、当然あなただと分かります。匿名で見たいときはログインしないでください
- Google や Cloudflare を使うサイトは、データセンターの IP からのアクセスに CAPTCHA を出すことがあります
- 音声、ファイルのダウンロードとアップロードには対応していません
- 誰でも使えるプロキシにすると悪用されて、サーバーの契約を止められることがあります。信頼できる人だけ承認してください

前のプロジェクト「りすかメーカー」のコードは、コミット `8b7de8c` に残っています。
