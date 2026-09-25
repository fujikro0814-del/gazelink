// "説明": a one-minute explanation for graders.
const REPO = 'https://github.com/fujikro0814-del/gazelink';

function Diagram() {
  return (
    <svg className="about-diagram" viewBox="0 0 760 210" role="img" aria-label="システム構成図">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#8593a3" />
        </marker>
      </defs>
      <rect x="10" y="20" width="230" height="170" rx="8" className="box" />
      <text x="125" y="44" className="h">ブラウザ（操作者）</text>
      <text x="30" y="72">・手（マウス）→ 主側の仮想質量</text>
      <text x="30" y="94">　1 kHz 物理・TDPA 主側</text>
      <text x="30" y="116">・視線（マウスで代用）→ 3D の交点</text>
      <text x="30" y="138">・3D 描画・グラフ・計測</text>
      <text x="30" y="160">・時刻同期（NTP 方式）</text>

      <rect x="290" y="20" width="180" height="170" rx="8" className="box net" />
      <text x="380" y="44" className="h">GLP/1（自作）</text>
      <text x="305" y="72">CMD 100 Hz（88 B）→</text>
      <text x="305" y="94">GAZE 30 Hz（42 B）→</text>
      <text x="305" y="116">← STATE 100 Hz（192 B）</text>
      <text x="305" y="138">SYNC・PING・EVENT…</text>
      <text x="305" y="166" className="small">WS → SSE+POST → Worker</text>

      <rect x="520" y="20" width="230" height="170" rx="8" className="box" />
      <text x="635" y="44" className="h">サーバ（遠隔側）</text>
      <text x="540" y="72">・劣化器：遅延・揺らぎ・損失</text>
      <text x="540" y="94">　（Gilbert–Elliott）</text>
      <text x="540" y="116">・従側 1 kHz 物理・TDPA 従側</text>
      <text x="540" y="138">・注意の場 → b(t)</text>
      <text x="540" y="160">・部屋と観戦者への配信</text>

      <line x1="242" y1="95" x2="288" y2="95" stroke="#8593a3" markerEnd="url(#arr)" />
      <line x1="472" y1="95" x2="518" y2="95" stroke="#8593a3" markerEnd="url(#arr)" />
      <line x1="518" y1="125" x2="472" y2="125" stroke="#8593a3" markerEnd="url(#arr)" />
      <line x1="288" y1="125" x2="242" y2="125" stroke="#8593a3" markerEnd="url(#arr)" />
    </svg>
  );
}

export function AboutView() {
  return (
    <div className="about">
      <h2>GazeLink：遅延ネットワーク越しの視線適応型遠隔操作</h2>
      <p className="lead">
        ブラウザ（手元）から、サーバ上で動くロボットアーム（Franka Panda 風の 7 軸）を遠隔操作するシミュレータです。
        両者は<b>自作のアプリケーション層プロトコル GLP/1</b> でつながり、サーバの中で人工的に遅延・揺らぎ・損失をかけられます。
        遅延があると、力を返す遠隔操作は不安定になります。それを<b>受動性（エネルギーを生み出さない性質）</b>の観点で観測し、抑える様子と、
        <b>見ている場所に応じて手元の重さ（ダンピング）を変える</b>支援制御を、目で見て確かめられます。
      </p>

      <h3>操作</h3>
      <p>
        <b>アームはキーボード、視線はマウス</b>で操作します。3D 画面を一度クリックしてキー入力を受け付けさせてから、
        W・A・S・D で手を水平に（今の視点から見た前後左右に）、Q・E で上下に動かします。Shift を押している間は低速になり、精密に動かせます。
        マウスカーソルの先が「視線」（桃色の点）です。右ドラッグで視点の回転（その間は視線を止めます）、ホイールで拡大縮小です。
      </p>

      <h3>最初に試すと面白いこと</h3>
      <ol className="tries">
        <li>
          <b>遅延で発振させて、TDPA で止める。</b>
          右の制御盤で「視線適応」を OFF、遅延を 300 ms にし、W（と A・D）で手を壁（半透明の板）の奥まで押し込みます。
          方式「なし」ではアームが壁で跳ね返りを繰り返し、下のエネルギーのグラフで「通信路の生成エネルギー」（赤）が正に増え続けます。
          「TDPA」に切り替えると跳ね返りが収まり、赤の線は 0 以下にとどまります。
        </li>
        <li>
          <b>見ている場所で重さが変わる。</b>
          マウスを動かすと、その先が「視線」になり、床に注意の熱分布が広がります。
          緑の箱にカーソルを置いたままキーで手を箱へ運ぶと軽く、カーソルをよそに置いたまま動かすと b(t) が上がって重くなります（ゴーストの遅れで分かります）。
          視線適応 ON なら、遅延 200 ms の「なし」でも壁で発振しにくくなります。
        </li>
        <li>
          <b>プロトコルを覗く。</b>
          「プロトコル観察」で、流れるメッセージのバイナリ（16 進）と解釈、斜めの矢印のシーケンス図、
          設定した遅延・損失と実際に観測された分布の比較を見られます。別のタブで部屋番号を入れると観戦者として同期します。
        </li>
      </ol>

      <h3>しくみ</h3>
      <Diagram />

      <h3>用語</h3>
      <dl className="terms">
        <dt>受動性</dt>
        <dd>系が外から受け取った以上のエネルギーを出さない性質。受動的な要素どうしをつなげば、全体も安定側にとどまります。遅延のある通信路は、そのままではこの性質を破ります。</dd>
        <dt>TDPA</dt>
        <dd>時間領域受動性の手法。通信路の両端で出入りするエネルギーを積算し、相手から届いた量を超えて出しそうな瞬間だけ、可変ダンピングで余剰を消します。</dd>
        <dt>波変数</dt>
        <dd>速度と力を「波」に変換して送る受動化の手法。遅延の大きさによらず受動的ですが、自由空間でも粘りを感じ、位置がずれていきます。</dd>
        <dt>視線適応ダンピング</dt>
        <dd>過去の視線を時間とともに忘れながら積算した「注意の場」と、障害物（壁）までの距離から、減衰係数 b(t) を決めます。b(t) ≥ 0 なのでエネルギーを消すだけで、受動性は壊しません。</dd>
      </dl>

      <p className="muted">
        仕様書：
        <a href={`${REPO}/blob/main/docs/PROTOCOL.md`} target="_blank" rel="noreferrer">
          プロトコル（docs/PROTOCOL.md）
        </a>
        ・
        <a href={`${REPO}/blob/main/docs/CONTROL.md`} target="_blank" rel="noreferrer">
          制御の定式化（docs/CONTROL.md）
        </a>
        ・
        <a href={REPO} target="_blank" rel="noreferrer">
          ソースコード
        </a>
        。カメラは使わず、視線はマウスカーソルで代用しています。
      </p>
    </div>
  );
}
