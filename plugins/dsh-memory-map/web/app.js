// 记忆星图 · 3D 星云前端（Three.js）—— 美术升级版
// 源文件：web/app.js（ESM）。由 build.mjs 用 esbuild 打成 web/app.bundle.js（IIFE），
// 内嵌 three + addons，零 CDN 依赖，可直接双击 file:// 打开。
//
// 美术灵魂：
//   1) 十字星芒：每颗星的 Sprite/Points 纹理带衍射星芒（Diffraction Spikes），像真实恒星。
//   2) 扁平盘/螺旋星系：后端把同一星系的星排在扁平螺旋盘内；前端把盘面对齐到「朝外」法线。
//   3) 星系自转：每个星系 = 一个 Group，盘面法线朝外，绕自身法线 rotateZ 慢转。
//   4) 全局公转：所有星系挂在 constellationGroup 下，整体绕原点主星缓慢公转。
//   5) 全局核心主星：原点 (0,0,0) 一颗最大最亮的金色主星（人格卡「鲸鲸」），所有星系绕它转。
//   6) 微弱连线：星系内每颗星连其最近邻，极细极暗同色，体现关联图谱但不成蛛网。
//   7) 星星呼吸闪烁：shader 内 uTime * aFreq + aPhase，每星周期错开，大小与亮度正弦起伏。
//   8) 入场镜头：相机从极远 lerp 飞入全览位，完成后立即把控制权交还 OrbitControls。
//   9) 悬停：命中星 shader 变纯白 + 放大，其他星系顶点色变暗；弹深色毛玻璃 tooltip。
//   10) 标签：纯白字 + 半透黑圆角毛玻璃底，上浮于星系中心上方，不被星点淹没。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

// ---------------------------------------------------------------------------
// 可调视觉参数（迭代就改这里）
// ---------------------------------------------------------------------------
const CFG = {
  // —— 深邃星图：锐利十字星芒 + 加法混合成团，泛光克制 ——
  exposure: 1.0,
  bloomStrength: 0.4,
  bloomRadius: 0.4,
  bloomThreshold: 0.2,

  spinSpeed: 0.0012,        // 星系自转角速度/帧
  pulseAmp: 0.22,           // 呼吸幅度
  pulseFreqBase: 0.7,       // 呼吸基础频率
  hoverBoostSize: 1.6,      // 悬停命中星放大倍率

  introDuration: 1900,      // 入场时长 ms
  introStartZ: 3200,        // 入场起点（极远，留白）
  bgDriftSpeed: 0.00014,    // 背景星尘漂移速度
  starPixelScale: 900,      // 星点放大 3x，加法混合后自然形成发光星云团

  globalOrbitSpeed: 0.00012,// 整个星系群绕主星公转速度/帧

  // —— 主星：金色，放大凸显，真正闪耀 ——
  coreColor: '#f0d9a0',
  coreSize: 110,
  coreGlow: 280,

  // —— 悬浮连线（默认隐藏，hover / 点击才弹出）——
  lineOpacity: 0.75,
  hoverNeighbors: 5,        // hover 某星时，连它同星系最近的 N 个邻居
  coreLinkOpacity: 0.5,

  // —— Star Chart 文字：只保留星系分类标签（默认干净深邃，具体内容 hover 才出 tooltip）——
  textPxToWorld: 1.25,      // CSS 像素 → 世界单位
  textDefaultOpacity: 0.65, // 默认文字透明度
  textDimOpacity: 0.2,      // 无关文字压暗（聚焦时背景文字）
  textBrightOpacity: 1.0,   // 命中文字点亮
  labelCamBias: 34,         // 标签向镜头偏置（避免被星点 bloom 吞噬）
  labelDrop: 2.0,           // 标签放在星系正下方 = clusterR × 该值（压到晕圈外缘之下）
  labelDropExtra: 18,       // 正下方额外距离
  labelJitter: 10,          // 标签横向微偏移（避免重叠 + 排版呼吸感）

  // —— 星尘（散星）依附：每星系核心主记忆高亮，其余记忆化作外围晕圈星尘 ——
  dustCoreFrac: 0.3,        // 每星系取重要度最高的 30% 作为「核心主记忆」（亮 + 十字星芒）
  dustCoreMin: 2,           // 核心星最少数量（小星系也保证有亮核）
  dustCoreMax: 8,           // 核心星最多数量（大星系核心不过度膨胀）
  dustHaloInner: 1.0,       // 星尘晕圈内缘 = diskR × 该值（紧贴主盘面外缘）
  dustHaloOuter: 1.9,       // 星尘晕圈外缘 = diskR × 该值
  dustSizeScale: 0.36,      // 散星尺寸倍率（相对核心星）
  dustBright: 0.42,         // 散星亮度倍率
  dustCoreSpike: 0.08,      // 散星锐利星芒强度（核心星 = 1.0，散星几乎无芒）
  dustAlpha: 0.72,          // 散星透明度（缥缈感）
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
let scene, camera, renderer, composer, controls, bloomPass
let starsMat                              // 所有星系星点共用的 ShaderMaterial
let constellationGroup                    // 所有星系的父组（整体绕主星公转）
let coreStar                              // 原点主星 { group, core, glow }
let hoverLines, coreLines                 // 悬浮连线组（默认空 = 不可见，hover/点击才显）
let coreLinksActive = false               // 点击主星后是否显示「主星→各星系」连线
let clusterGroups = new Map()             // cid -> { group, points, geom, baseColors, colorArr, hoverArr, starIndices, center, spin, clusterR }
let allPoints = []                        // 供 raycaster 拾取的 Points 列表
let bgGroup                               // 背景星尘组（整体慢转 = 漂移）

// —— Star Chart 3D 文字系统 ——
let textGroup                             // 所有 3D 文字 Sprite + 指示线的父组（挂在 scene，世界坐标每帧刷新）
let clusterTextLabels = new Map()         // cid -> { sprite, line }
let memoryLabels = []                     // [{ sprite, cid, li }]  高光记忆短句
let coreText, coreSubText                 // 主星「哦鲸鲸」金光大字 + 副标题（持久，不随重建销毁）

let starData = []
let clusterMap = {}                       // cid -> { label, center, color, count }

let hoverIndex = -1
let hoverCluster = null
let focus = null                          // { target:Vector3, camPos:Vector3, active }
let focusCid = null                       // 当前聚焦的星系 cid（用于点亮该星系标签）
let intro = null                          // { active, startT, fromPos, toPos }
const defaultCamPos = new THREE.Vector3(0, 300, 1080)  // 斜俯视：星系群躺在水平 XZ 面，横向铺开 + 纵深
const defaultTarget = new THREE.Vector3(0, 0, 0)
const ORIGIN = new THREE.Vector3(0, 0, 0)

const pointer = new THREE.Vector2()
const raycaster = new THREE.Raycaster()
raycaster.params.Points.threshold = 14

const _v3 = new THREE.Vector3()
const _v3b = new THREE.Vector3()
const _v3c = new THREE.Vector3()
const _v3d = new THREE.Vector3()

// ---------------------------------------------------------------------------
// 纹理：Canvas 生成「十字星芒」星点纹理 + 星云辉光
// ---------------------------------------------------------------------------
function makeDotTexture() {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, S, S)
  ctx.globalCompositeOperation = 'lighter'
  const cx = S / 2, cy = S / 2

  // 中心核：径向渐变
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, S / 2)
  g.addColorStop(0.0, 'rgba(255,255,255,1)')
  g.addColorStop(0.16, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.42, 'rgba(255,255,255,0.22)')
  g.addColorStop(1.0, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)

  // 衍射星芒：4 条主芒（横竖）+ 4 条副芒（对角，更短更淡）
  const spikes = [
    { a: 0,            len: 60, w: 2.4, a0: 1.0 },
    { a: Math.PI / 2,   len: 60, w: 2.4, a0: 1.0 },
    { a: Math.PI,       len: 60, w: 2.4, a0: 1.0 },
    { a: Math.PI * 1.5, len: 60, w: 2.4, a0: 1.0 },
    { a: Math.PI / 4,        len: 42, w: 1.3, a0: 0.65 },
    { a: 3 * Math.PI / 4,    len: 42, w: 1.3, a0: 0.65 },
    { a: 5 * Math.PI / 4,    len: 42, w: 1.3, a0: 0.65 },
    { a: 7 * Math.PI / 4,    len: 42, w: 1.3, a0: 0.65 },
  ]
  for (const sp of spikes) {
    const x2 = cx + Math.cos(sp.a) * sp.len
    const y2 = cy + Math.sin(sp.a) * sp.len
    const grad = ctx.createLinearGradient(cx, cy, x2, y2)
    grad.addColorStop(0, `rgba(255,255,255,${(0.9 * sp.a0).toFixed(3)})`)
    grad.addColorStop(0.55, `rgba(255,255,255,${(0.32 * sp.a0).toFixed(3)})`)
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.strokeStyle = grad
    ctx.lineWidth = sp.w
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function makeGlowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0.0, 'rgba(255,255,255,0.5)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.2)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.05)')
  g.addColorStop(1.0, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// ---------------------------------------------------------------------------
// Star Chart 文字：透明 Canvas 画衬线字 → CanvasTexture → Sprite
// （始终面向镜头、带微光，无黑底无边框，复古天文星系图质感）
// ---------------------------------------------------------------------------
const SERIF = '"Songti SC", "SimSun", Georgia, "Times New Roman", "Noto Serif SC", serif'

function makeTextTexture(text, opts) {
  const {
    fontSize = 14,
    color = '#e0e0e0',
    glow = 'rgba(224,224,224,0.6)',
    glowBlur = 6,
    fontWeight = '300',
    fontFamily = SERIF,
    dpr = 2,
    pad = 6,
    letterSpacing = 0,
  } = opts || {}
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  const fontStr = `${fontWeight} ${fontSize}px ${fontFamily}`
  ctx.font = fontStr
  const metrics = ctx.measureText(text)
  let cssW = Math.ceil(metrics.width) + pad * 2
  if (letterSpacing) cssW += Math.max(0, text.length - 1) * letterSpacing
  const cssH = Math.ceil(fontSize * 1.5) + pad * 2
  c.width = Math.ceil(cssW * dpr)
  c.height = Math.ceil(cssH * dpr)
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.font = fontStr
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = glowBlur }
  if (letterSpacing && text.length > 1) {
    // 逐字绘制以支持字距（天文图批注的疏朗感）
    const widths = []
    let total = 0
    for (let i = 0; i < text.length; i++) {
      const w = ctx.measureText(text[i]).width
      widths.push(w); total += w
    }
    total += (text.length - 1) * letterSpacing
    let x = (cssW - total) / 2
    const y = cssH / 2
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], x + widths[i] / 2, y)
      x += widths[i] + letterSpacing
    }
  } else {
    ctx.fillText(text, cssW / 2, cssH / 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return { texture: tex, cssW, cssH }
}

function makeTextSprite(text, opts) {
  const { texture, cssW, cssH } = makeTextTexture(text, opts)
  const mat = new THREE.SpriteMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    depthTest: false,          // 文字始终浮于最上层，像天文图的批注层
    opacity: opts.opacity ?? CFG.textDefaultOpacity,
  })
  const sp = new THREE.Sprite(mat)
  const w = cssW * CFG.textPxToWorld
  const h = cssH * CFG.textPxToWorld
  sp.scale.set(w, h, 1)
  sp.userData.baseScale = new THREE.Vector3(w, h, 1)
  sp.userData._f = 1
  sp.userData.texture = texture
  return sp
}

function makeIndicatorLine(color, opacity) {
  const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
  const mat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, depthTest: false,
  })
  return new THREE.Line(geom, mat)
}

function updateLinePoints(line, a, b) {
  const pos = line.geometry.attributes.position
  pos.setXYZ(0, a.x, a.y, a.z)
  pos.setXYZ(1, b.x, b.y, b.z)
  pos.needsUpdate = true
}

// ---------------------------------------------------------------------------
// 自定义着色器：逐点大小/染色 + 呼吸 + 悬停纯白放大
// ---------------------------------------------------------------------------
const starVS = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aFreq;
  attribute float aHover;
  attribute float aRadius;      // 0 = 星系中心, 1 = 星系边缘
  attribute float aDust;        // 0 = 核心主记忆, 1 = 外围晕圈星尘
  uniform float uTime;
  varying vec3 vColor;
  varying float vPulse;
  varying float vHover;
  varying float vRadius;
  varying float vDepth;
  varying float vDust;
  void main() {
    vHover = aHover;
    vRadius = aRadius;
    vDust = aDust;
    float pulse = ${(1 - CFG.pulseAmp).toFixed(3)} + ${CFG.pulseAmp.toFixed(3)} * sin(uTime * aFreq + aPhase);
    vPulse = pulse;
    vColor = aColor;
    vec3 pos = position;
    // 散星（晕圈）缓慢漂浮：沿径向 + 切向做小幅正弦漂移，仿佛星系向外散发的记忆光尘
    // （星系整体自转已由 group.rotation 提供，这里叠加独立的缥缈漂浮）
    if (aDust > 0.5) {
      float rlen = length(position.xy) + 1e-4;
      vec2 dir = position.xy / rlen;
      float slow = uTime * 0.16 + aPhase * 1.7 + aFreq * 2.3;
      float amp = rlen * 0.07;                 // 漂移幅度 = 半径的 7%（随星系尺度自适应）
      float radial = sin(slow) * amp;
      float tang = cos(slow * 0.83) * amp * 0.85;
      pos.xy += dir * radial + vec2(-dir.y, dir.x) * tang;
      pos.z += sin(slow * 1.15) * amp * 0.5;
    }
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    float dist = max(-mv.z, 1.0);
    // 景深：近处亮大、远处暗小（制造空间纵深感）
    vDepth = clamp((1550.0 - dist) / 1150.0, 0.2, 1.0);
    // 半径梯度：中心略大、边缘略小（保持离散，不过度压扁）
    float sizeFalloff = mix(1.0, 0.55, aRadius);
    float boost = 1.0 + ${CFG.hoverBoostSize.toFixed(3)} * aHover;
    float sizeDust = mix(1.0, ${CFG.dustSizeScale.toFixed(3)}, aDust);
    gl_PointSize = aSize * pulse * sizeFalloff * boost * sizeDust * (${CFG.starPixelScale.toFixed(1)} / dist);
    gl_Position = projectionMatrix * mv;
  }
`
const starFS = /* glsl */ `
  uniform sampler2D uTex;
  varying vec3 vColor;
  varying float vPulse;
  varying float vHover;
  varying float vRadius;
  varying float vDepth;
  varying float vDust;
  void main() {
    vec4 t = texture2D(uTex, gl_PointCoord);
    if (t.a < 0.02) discard;
    // 悬停命中 → 纯白；其余保持星色
    vec3 col = mix(vColor, vec3(1.0), vHover);
    // 半径梯度：中心略亮、边缘略暗（保持离散光点，不糊成光团）
    float radBright = mix(1.0, 0.6, vRadius);
    // 散星（晕圈）压暗；但 hover 命中时恢复全亮（保证悬浮反馈在散星上也清晰）
    float dustScale = mix(mix(1.0, ${CFG.dustBright.toFixed(3)}, vDust), 1.0, vHover);
    // 锐利光点：基础亮度克制，加法混合不致糊
    col *= (0.7 + 0.8 * t.a) * vPulse * radBright * vDepth * dustScale;
    // 白热核心（十字星芒）：核心星强，散星几乎无芒；hover 时恢复芒刺
    float spike = mix(mix(1.0, ${CFG.dustCoreSpike.toFixed(3)}, vDust), 1.0, vHover);
    col += vec3(1.0) * smoothstep(0.6, 1.0, t.a) * (0.28 + 0.7 * vHover) * radBright * spike;
    float a = t.a * mix(mix(1.0, ${CFG.dustAlpha.toFixed(3)}, vDust), 1.0, vHover);
    gl_FragColor = vec4(col, a);
  }
`

function hexToRgb01(hex) {
  const h = (hex || '#ffffff').replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** 确定性哈希 → [0,1)：memory_id 派生稳定的星尘晕圈坐标（跨刷新不跳变）。 */
function hashStr01(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** 统一冷色调：亮白核心 / 冰蓝中层 / 银灰星尘，无任何彩色（忽略后端给的彩色） */
function coldStarColor(importance) {
  const imp = Number.isFinite(importance) ? importance : 2
  if (imp >= 3) return '#eef4ff'   // 亮冷白（核心主记忆）
  if (imp >= 2) return '#cfe3ff'   // 冰蓝（中层）
  return '#c2c8d4'                 // 银灰（星尘，暗）
}

// ---------------------------------------------------------------------------
// 渲染链路初始化
// ---------------------------------------------------------------------------
function initThree() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x02030a)
  scene.fog = new THREE.FogExp2(0x02030a, 0.0006)

  const w = window.innerWidth
  const h = window.innerHeight
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 8000)
  camera.position.set(0, 0, CFG.introStartZ)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = CFG.exposure
  renderer.domElement.id = 'graph'
  document.body.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.rotateSpeed = 0.55
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.22
  controls.minDistance = 140
  controls.maxDistance = 4200
  controls.target.copy(defaultTarget)
  // 入场期间禁用用户控制，避免与镜头 lerp 冲突
  controls.enabled = false
  controls.autoRotate = false

  // 所有星系星点共用一个材质：uTime 在渲染循环里更新一次即驱动全部
  starsMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: makeDotTexture() }, uTime: { value: 0 } },
    vertexShader: starVS,
    fragmentShader: starFS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  // 星系公转型：所有星系挂在这里，整体绕主星缓慢公转
  constellationGroup = new THREE.Group()
  scene.add(constellationGroup)

  // 悬浮连线组（默认空，hover 星 / 点击主星时才往里加线）
  hoverLines = new THREE.Group()
  coreLines = new THREE.Group()
  scene.add(hoverLines)
  scene.add(coreLines)

  // Star Chart 3D 文字层：所有文字 Sprite + 指示线挂在这里，世界坐标每帧刷新
  textGroup = new THREE.Group()
  scene.add(textGroup)

  // 后处理：RenderPass → UnrealBloomPass → OutputPass
  composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), CFG.bloomStrength, CFG.bloomRadius, CFG.bloomThreshold)
  composer.addPass(bloomPass)
  composer.addPass(new OutputPass())

  window.addEventListener('resize', onResize)
}

function onResize() {
  const w = window.innerWidth
  const h = window.innerHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  composer.setSize(w, h)
  bloomPass.setSize(w, h)
}

// ---------------------------------------------------------------------------
// 深空背景：星点球壳 + 较近星尘层，整体极慢旋转 = 漂移
// ---------------------------------------------------------------------------
function buildBackground() {
  bgGroup = new THREE.Group()
  const glowTex = makeDotTexture()

  const N = 4200
  const pos = new Float32Array(N * 3)
  const col = new Float32Array(N * 3)
  const tmp = new THREE.Color()
  for (let i = 0; i < N; i++) {
    const r = 1800 + Math.random() * 700
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    pos[i * 3 + 1] = r * Math.cos(phi)
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    tmp.setHSL(0.57 + Math.random() * 0.08, 0.38, 0.5 + Math.random() * 0.32)
    col[i * 3] = tmp.r
    col[i * 3 + 1] = tmp.g
    col[i * 3 + 2] = tmp.b
  }
  const g1 = new THREE.BufferGeometry()
  g1.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g1.setAttribute('color', new THREE.BufferAttribute(col, 3))
  bgGroup.add(new THREE.Points(g1, new THREE.PointsMaterial({
    size: 1.7, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
  })))

  const M = 600
  const p2 = new Float32Array(M * 3)
  const c2 = new Float32Array(M * 3)
  const s2 = new Float32Array(M)
  for (let i = 0; i < M; i++) {
    const r = 950 + Math.random() * 700
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    p2[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    p2[i * 3 + 1] = r * Math.cos(phi)
    p2[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    tmp.setHSL(0.58 + Math.random() * 0.06, 0.35, 0.62 + Math.random() * 0.28)
    c2[i * 3] = tmp.r; c2[i * 3 + 1] = tmp.g; c2[i * 3 + 2] = tmp.b
    s2[i] = 10 + Math.random() * 26
  }
  const g2 = new THREE.BufferGeometry()
  g2.setAttribute('position', new THREE.BufferAttribute(p2, 3))
  g2.setAttribute('color', new THREE.BufferAttribute(c2, 3))
  g2.setAttribute('size', new THREE.BufferAttribute(s2, 1))
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: glowTex }, uTime: { value: 0 } },
    vertexShader: `
      attribute float size; attribute vec3 color; uniform float uTime; varying vec3 vCol; varying float vA;
      void main(){ vCol=color; vec4 mv=modelViewMatrix*vec4(position,1.0);
        vA = 0.6 + 0.4*sin(uTime*0.5 + position.x*0.01 + position.y*0.013);
        gl_PointSize = size * (260.0/max(-mv.z,1.0)); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `
      uniform sampler2D uTex; varying vec3 vCol; varying float vA;
      void main(){ vec4 t=texture2D(uTex,gl_PointCoord); if(t.a<0.02)discard;
        gl_FragColor=vec4(vCol*t.a*vA, t.a*vA*0.5); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  const dust = new THREE.Points(g2, dustMat)
  dust.userData.isDust = true
  bgGroup.add(dust)

  scene.add(bgGroup)
}

// ---------------------------------------------------------------------------
// 全局核心主星：原点最大最亮金色星（人格卡「鲸鲸」）
// ---------------------------------------------------------------------------
function buildCoreStar() {
  if (coreStar) return
  const tex = makeDotTexture()
  const coreMat = new THREE.SpriteMaterial({
    map: tex, color: new THREE.Color(CFG.coreColor),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  const core = new THREE.Sprite(coreMat)
  core.scale.set(CFG.coreSize, CFG.coreSize, 1)
  core.userData.baseScale = CFG.coreSize

  // 淡金小辉光（仅一点，不大面积照耀）
  const glowMat = new THREE.SpriteMaterial({
    map: makeGlowTexture(), color: new THREE.Color(CFG.coreColor),
    transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  const glow = new THREE.Sprite(glowMat)
  glow.scale.set(CFG.coreGlow, CFG.coreGlow, 1)
  glow.userData.baseScale = CFG.coreGlow

  const group = new THREE.Group()
  group.position.copy(ORIGIN)
  group.add(glow)
  group.add(core)
  scene.add(group)
  coreStar = { group, core, glow }

  // 主星文字：「哦鲸鲸」金色微光大字（复古天文图主星标注），持久不随重建销毁
  if (!coreText) {
    coreText = makeTextSprite('哦鲸鲸', {
      fontSize: 36, color: '#f5d9a0', glow: 'rgba(255,214,150,0.85)', glowBlur: 12,
      fontWeight: '600', letterSpacing: 6, opacity: 0.92,
    })
    scene.add(coreText)
    coreSubText = makeTextSprite('鲸鱼娘 · 记忆主星', {
      fontSize: 12, color: '#e8d4a0', glow: 'rgba(240,210,150,0.6)', glowBlur: 6,
      fontWeight: '300', letterSpacing: 3, opacity: 0.7,
    })
    scene.add(coreSubText)
  }
}

// ---------------------------------------------------------------------------
// 构建 / 重建记忆星云
// ---------------------------------------------------------------------------
function clearConstellation() {
  clusterGroups.forEach((rec) => {
    constellationGroup.remove(rec.group)
    rec.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material && o.material !== starsMat) {
        if (o.material.map) o.material.map.dispose()
        o.material.dispose()
      }
    })
  })
  clusterGroups.clear()
  allPoints = []
  if (starsMat) { /* 复用，不清 */ }
  clearText3D()   // 销毁星系标签 / 高光记忆短句（主星文字 coreText 持久保留）
  starData = []
  clusterMap = {}
  clearLineGroup(hoverLines)
  clearLineGroup(coreLines)
  coreLinksActive = false
  hoverIndex = -1
  hoverCluster = null
}

// 注：星系间的聚集感完全靠星点在空间里靠近 + 加法混合光晕叠加，不画任何连线。

function buildConstellation(snapshot) {
  clearConstellation()

  starData = snapshot.stars || []
  const clusters = snapshot.clusters || []

  clusterMap = {}
  clusters.forEach((cl) => {
    clusterMap[cl.cluster_id] = {
      cluster_id: cl.cluster_id,
      label: cl.label,
      center: cl.center || { x: 0, y: 0, z: 0 },
      color: '#88aaff',
      count: cl.count || 0,
      indices: [],
    }
  })
  starData.forEach((s, i) => {
    if (clusterMap[s.cluster_id]) clusterMap[s.cluster_id].indices.push(i)
  })
  Object.values(clusterMap).forEach((cl) => {
    for (const i of cl.indices) {
      const c = starData[i].color
      if (c && c.toLowerCase() !== '#ffd87a') { cl.color = c; break }
    }
  })

  Object.values(clusterMap).forEach((cl) => {
    const cx = cl.center.x, cy = cl.center.y, cz = cl.center.z
    const m = cl.indices.length
    const positions = new Float32Array(m * 3)
    const colors = new Float32Array(m * 3)
    const sizes = new Float32Array(m)
    const phases = new Float32Array(m)
    const freqs = new Float32Array(m)
    const hovers = new Float32Array(m)
    const radii = new Float32Array(m)         // 0=星系中心, 1=边缘，供 shader 半径梯度
    const dusts = new Float32Array(m)         // 0=核心主记忆, 1=外围晕圈星尘
    const baseColors = new Float32Array(m * 3)
    const starIndices = new Int32Array(m)
    const dists = new Array(m)

    // 每星系独立排名：取重要度最高的 top N 为「核心主记忆」（亮 + 星芒 + 盘面内），
    // 其余记忆重定位到外围晕圈（暗 + 小 + 无芒 + 缓慢漂浮）。
    // 不能用全局 importance 阈值——快照里亮星几乎都集中在单个星系，会导致其余 14 个星系全黑。
    const coreN = Math.max(CFG.dustCoreMin, Math.min(CFG.dustCoreMax, Math.min(m, Math.round(m * CFG.dustCoreFrac))))
    const ranked = cl.indices.slice().sort((a, b) => {
      const sa = starData[a], sb = starData[b]
      const di = (sb.importance || 1) - (sa.importance || 1)
      if (di !== 0) return di
      return (sb.size || 0) - (sa.size || 0)
    })
    const coreSet = new Set(ranked.slice(0, coreN))
    const diskR = 16 + Math.sqrt(Math.max(1, m)) * 6.5   // 与后端 starFor 的 clusterR 一致

    let localR = 1
    cl.indices.forEach((gi, li) => {
      const s = starData[gi]
      const isCore = coreSet.has(gi)
      let lx, ly, lz
      if (isCore) {
        // 核心主记忆：保持后端螺旋盘面坐标
        lx = (s.x || 0) - cx
        ly = (s.y || 0) - cy
        lz = (s.z || 0) - cz
      } else {
        // 散星：重定位到盘面外围的晕圈（星尘带），由 memory_id 哈希派生 → 跨刷新稳定
        const mid = String(s.memory_id != null ? s.memory_id : gi)
        const h1 = hashStr01(mid + '|ht')
        const h2 = hashStr01(mid + '|ha')
        const h3 = hashStr01(mid + '|hz')
        const haloR = diskR * (CFG.dustHaloInner + (CFG.dustHaloOuter - CFG.dustHaloInner) * Math.sqrt(h1))
        const ang = h2 * Math.PI * 2
        lx = Math.cos(ang) * haloR
        ly = Math.sin(ang) * haloR
        lz = (h3 * 2 - 1) * diskR * 0.14
      }
      dusts[li] = isCore ? 0 : 1
      positions[li * 3] = lx
      positions[li * 3 + 1] = ly
      positions[li * 3 + 2] = lz
      const dd = Math.sqrt(lx * lx + ly * ly + lz * lz)
      dists[li] = dd
      if (dd > localR) localR = dd
      const [r, g, b] = hexToRgb01(coldStarColor(s.importance))
      colors[li * 3] = baseColors[li * 3] = r
      colors[li * 3 + 1] = baseColors[li * 3 + 1] = g
      colors[li * 3 + 2] = baseColors[li * 3 + 2] = b
      sizes[li] = 2 + (s.size || 5) * 3.0
      phases[li] = Math.random() * Math.PI * 2
      freqs[li] = CFG.pulseFreqBase + Math.random() * 1.3
      hovers[li] = 0
      starIndices[li] = gi
    })
    // 半径归一化：localR 确定后回填 aRadius（中心 0 → 边缘 1）
    for (let li = 0; li < m; li++) radii[li] = localR > 1e-6 ? dists[li] / localR : 0

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
    geom.setAttribute('aFreq', new THREE.BufferAttribute(freqs, 1))
    geom.setAttribute('aHover', new THREE.BufferAttribute(hovers, 1))
    geom.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1))
    geom.setAttribute('aDust', new THREE.BufferAttribute(dusts, 1))

    const points = new THREE.Points(geom, starsMat)
    points.userData.starIndices = starIndices

    const group = new THREE.Group()
    group.position.set(cx, cy, cz)
    // 星系盘面水平躺（法线 +Y），与躺在 XZ 面的星系群一致：
    //   rotation.x = -π/2 把局部 xy 盘面翻到世界 xz 面；再绕 Z 做盘面内初始转角错开。
    //   相机斜俯视 → 每个星系都是清晰的水平圆盘；绕 Y 全局自转永不 edge-on。
    group.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2)

    group.add(points)
    constellationGroup.add(group)

    clusterGroups.set(cl.cluster_id, {
      cid: cl.cluster_id,
      group, points, geom,
      baseColors,
      colorArr: colors,
      hoverArr: hovers,
      starIndices,
      center: new THREE.Vector3(cx, cy, cz),
      spin: CFG.spinSpeed * (0.6 + Math.random() * 0.8),
      clusterR: localR,
    })
    allPoints.push(points)
  })

  buildCoreStar()
  buildText3D()
}

/** 取星系当前世界坐标（考虑公转） */
function clusterWorldPos(cid, out) {
  const rec = clusterGroups.get(cid)
  if (!rec) return out.copy(ORIGIN)
  rec.group.getWorldPosition(out)
  return out
}

// ---------------------------------------------------------------------------
// Star Chart 3D 文字：构建 / 销毁 / 每帧刷新
//   - 主星「哦鲸鲸」金光大字（在 buildCoreStar 内创建，持久不随重建销毁）
//   - 星系标签 14px 衬线银白 + 极细指示线（盘面上缘 → 向镜头偏置）
//   - 每个星系 importance 最高的 N 颗星旁渲染 10px 极小记忆短句
// ---------------------------------------------------------------------------
function clearText3D() {
  if (!textGroup) return
  while (textGroup.children.length) {
    const o = textGroup.children.pop()
    if (o.geometry) o.geometry.dispose()
    if (o.material) {
      if (o.material.map) o.material.map.dispose()
      o.material.dispose()
    }
  }
  clusterTextLabels.clear()
  memoryLabels.length = 0
}

function buildText3D() {
  if (!textGroup) return
  clusterTextLabels.clear()
  memoryLabels.length = 0   // 不再渲染任何单星文字：默认干净深邃，具体内容只在 hover tooltip 里出现

  clusterGroups.forEach((rec) => {
    // —— 每个星系只保留一个分类标签：纯白微光，放在星系正下方 ——
    const meta = clusterMap[rec.cid]
    const text = meta ? meta.label : rec.cid
    const sprite = makeTextSprite(text, {
      fontSize: 14, color: '#ffffff', glow: 'rgba(255,255,255,0.6)', glowBlur: 5,
      fontWeight: '300', letterSpacing: 3, opacity: CFG.textDefaultOpacity,
    })
    const line = makeIndicatorLine(0xffffff, CFG.textDefaultOpacity * 0.45)
    textGroup.add(line)
    textGroup.add(sprite)
    // 标签横向微偏移（cid 哈希派生，稳定不跳变）：避免相邻标签重叠 + 排版呼吸感
    let h = 0
    for (let i = 0; i < rec.cid.length; i++) h = ((h << 5) - h + rec.cid.charCodeAt(i)) | 0
    const jx = ((h % 1000) / 1000 - 0.5) * 2 * CFG.labelJitter
    clusterTextLabels.set(rec.cid, { sprite, line, jx })
  })
}

function lerpTextSprite(sp, targetOpacity, targetScale) {
  const m = sp.material
  m.opacity += (targetOpacity - m.opacity) * 0.12
  sp.userData._f += (targetScale - sp.userData._f) * 0.12
  const f = sp.userData._f
  const bs = sp.userData.baseScale
  sp.scale.set(bs.x * f, bs.y * f, 1)
}

/** 每帧：追踪星系/星的世界坐标（含公转 + 自转），并按 hover / focus 动态明暗 */
function updateText3D() {
  const activeCid = hoverIndex >= 0 ? hoverCluster : (focus && focus.active ? focusCid : null)

  // 1) 主星文字：始终高亮金色，向镜头偏置避免被主星辉光吞噬
  if (coreText && coreSubText) {
    _v3.copy(camera.position).sub(ORIGIN).normalize()
    coreText.position.copy(ORIGIN).addScaledVector(_v3, 46)
    coreText.position.y += 92
    coreSubText.position.copy(coreText.position)
    coreSubText.position.y -= 42
    coreText.material.opacity += (0.95 - coreText.material.opacity) * 0.1
    coreSubText.material.opacity += (0.75 - coreSubText.material.opacity) * 0.1
  }

  // 2) 星系分类标签 + 极细指示线（放在星系正下方，纯白微光）
  clusterTextLabels.forEach((item, cid) => {
    const rec = clusterGroups.get(cid)
    if (!rec) return
    const center = rec.group.getWorldPosition(_v3)
    // 镜头方向（星系 → 镜头）：把标签向镜头拉近，避免被星点 bloom 吞噬
    _v3b.copy(camera.position).sub(center).normalize()
    const drop = rec.clusterR * CFG.labelDrop + CFG.labelDropExtra
    const pos = _v3d.copy(center)
    pos.y -= drop                              // 星系正下方
    pos.x += item.jx                           // 横向微偏移（防重叠 + 呼吸感）
    pos.addScaledVector(_v3b, CFG.labelCamBias) // 再向镜头偏置
    item.sprite.position.copy(pos)
    updateLinePoints(item.line, center, pos)

    let op, sc
    if (activeCid === null) { op = CFG.textDefaultOpacity; sc = 1.0 }
    else if (activeCid === cid) { op = CFG.textBrightOpacity; sc = 1.3 }
    else { op = CFG.textDimOpacity; sc = 0.92 }
    lerpTextSprite(item.sprite, op, sc)
    item.line.material.opacity += (op * 0.45 - item.line.material.opacity) * 0.12
  })
}

// ---------------------------------------------------------------------------
// 悬停：命中星纯白+放大，其他星系变暗
// ---------------------------------------------------------------------------
function applyHover(globalIdx) {
  const hc = globalIdx >= 0 ? starData[globalIdx].cluster_id : null
  clusterGroups.forEach((rec) => {
    const same = hc !== null && rec.cid === hc
    const f = hc === null ? 1.0 : (same ? 1.0 : 0.18)
    const colorArr = rec.colorArr
    const hoverArr = rec.hoverArr
    const base = rec.baseColors
    for (let li = 0; li < rec.starIndices.length; li++) {
      const isHit = rec.starIndices[li] === globalIdx
      hoverArr[li] = isHit ? 1 : 0
      colorArr[li * 3] = base[li * 3] * f
      colorArr[li * 3 + 1] = base[li * 3 + 1] * f
      colorArr[li * 3 + 2] = base[li * 3 + 2] * f
    }
    rec.geom.attributes.aColor.needsUpdate = true
    rec.geom.attributes.aHover.needsUpdate = true
  })
}

function setHover(idx) {
  if (idx === hoverIndex) return
  hoverIndex = idx
  updateHoverLines(idx)
  if (clusterGroups.size === 0) return
  applyHover(idx)
  if (idx < 0) {
    hideTooltip()
    hoverCluster = null
    document.body.style.cursor = 'grab'
    // 离开悬停：若无聚焦，恢复相机自动公转
    if (!(focus && focus.active)) controls.autoRotate = true
  } else {
    hoverCluster = starData[idx].cluster_id
    document.body.style.cursor = 'pointer'
    controls.autoRotate = false // 悬停时停相机公转，便于细看
  }
}

// ---------------------------------------------------------------------------
// 交互：射线拾取、聚焦、重置
// ---------------------------------------------------------------------------
function updatePointer(e) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
}

function pickStar() {
  if (allPoints.length === 0) return -1
  const hits = raycaster.intersectObjects(allPoints, false)
  if (!hits.length) return -1
  const arr = hits[0].object.userData.starIndices
  return arr ? arr[hits[0].index] : -1
}

/** 射线是否命中原点主星 */
function pickCore() {
  if (!coreStar) return false
  raycaster.setFromCamera(pointer, camera)
  return raycaster.intersectObject(coreStar.core, false).length > 0
}

function clearLineGroup(g) {
  while (g.children.length) {
    const o = g.children.pop()
    if (o.geometry) o.geometry.dispose()
    if (o.material) o.material.dispose()
  }
}

/** hover 某星：极细白色虚线连它同星系最近的 N 个邻居；移开即清空 */
function updateHoverLines(globalIdx) {
  clearLineGroup(hoverLines)
  if (globalIdx < 0 || !starData[globalIdx]) return
  const s = starData[globalIdx]
  const rec = clusterGroups.get(s.cluster_id)
  if (!rec) return
  let li = -1
  for (let k = 0; k < rec.starIndices.length; k++) if (rec.starIndices[k] === globalIdx) { li = k; break }
  if (li < 0) return
  const posAttr = rec.geom.attributes.position
  const hitLocal = new THREE.Vector3().fromBufferAttribute(posAttr, li)
  const hitWorld = rec.group.localToWorld(hitLocal.clone())
  const cand = []
  for (let k = 0; k < rec.starIndices.length; k++) {
    if (k === li) continue
    const p = new THREE.Vector3().fromBufferAttribute(posAttr, k)
    cand.push({ k, d: p.distanceTo(hitLocal) })
  }
  cand.sort((a, b) => a.d - b.d)
  const n = Math.min(CFG.hoverNeighbors, cand.length)
  const pts = []
  for (let k = 0; k < n; k++) {
    const p = new THREE.Vector3().fromBufferAttribute(posAttr, cand[k].k)
    rec.group.localToWorld(p)
    pts.push(hitWorld, p)
  }
  const geom = new THREE.BufferGeometry().setFromPoints(pts)
  const mat = new THREE.LineDashedMaterial({
    color: 0xffffff, dashSize: 6, gapSize: 5,
    transparent: true, opacity: CFG.lineOpacity, depthWrite: false,
  })
  const line = new THREE.LineSegments(geom, mat)
  line.computeLineDistances()
  hoverLines.add(line)
}

/** 点击主星：主星 → 各星系中心的极细白色虚线（再点别处消失） */
function showCoreLinks() {
  clearLineGroup(coreLines)
  const pts = []
  clusterGroups.forEach((rec) => {
    const c = new THREE.Vector3()
    rec.group.getWorldPosition(c)
    pts.push(ORIGIN.clone(), c)
  })
  const geom = new THREE.BufferGeometry().setFromPoints(pts)
  const mat = new THREE.LineDashedMaterial({
    color: 0xffffff, dashSize: 8, gapSize: 6,
    transparent: true, opacity: CFG.coreLinkOpacity, depthWrite: false,
  })
  const line = new THREE.LineSegments(geom, mat)
  line.computeLineDistances()
  coreLines.add(line)
  coreLinksActive = true
}
function hideCoreLinks() { clearLineGroup(coreLines); coreLinksActive = false }
function toggleCoreLinks() { coreLinksActive ? hideCoreLinks() : showCoreLinks() }

function focusCluster(cid) {
  clusterWorldPos(cid, _v3)
  const center = _v3.clone()
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize()
  const dist = Math.max(170, Math.min(430, 190 + (clusterMap[cid]?.count || 1) * 9))
  focusCid = cid
  focus = {
    target: center,
    camPos: center.clone().addScaledVector(dir, dist),
    active: true,
  }
  controls.autoRotate = false
}

function resetView() {
  focusCid = null
  focus = { target: defaultTarget.clone(), camPos: defaultCamPos.clone(), active: true }
  controls.autoRotate = true
}

function bindInteraction() {
  let downX = 0, downY = 0, moved = false
  renderer.domElement.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY; moved = false
  })
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) moved = true
    updatePointer(e)
    const prev = hoverIndex
    const idx = pickStar()
    setHover(idx)
    if (idx >= 0) {
      if (idx !== prev) showTooltip(starData[idx], e.clientX, e.clientY)
      else moveTooltip(e.clientX, e.clientY)
    }
  })
  renderer.domElement.addEventListener('pointerleave', () => setHover(-1))
  renderer.domElement.addEventListener('click', (e) => {
    if (moved) return
    updatePointer(e)
    // 点击主星 → 切换「主星→各星系」连线
    if (pickCore()) { toggleCoreLinks(); return }
    hideCoreLinks()
    const idx = pickStar()
    if (idx >= 0) {
      focusCluster(starData[idx].cluster_id)
      showTooltip(starData[idx], e.clientX, e.clientY)
    }
  })
  renderer.domElement.addEventListener('dblclick', (e) => {
    updatePointer(e)
    if (pickStar() >= 0) return
    resetView()
  })
  const btnReset = document.getElementById('btn-reset')
  if (btnReset) btnReset.addEventListener('click', resetView)
  const btnRefresh = document.getElementById('btn-refresh')
  if (btnRefresh) btnRefresh.addEventListener('click', () => {
    btnRefresh.disabled = true
    load().finally(() => (btnRefresh.disabled = false))
  })
}

// ---------------------------------------------------------------------------
// HTML tooltip（毛玻璃，仅文字用 HTML）
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function showTooltip(star, mx, my) {
  const tt = document.getElementById('tooltip')
  if (!tt) return
  const d = new Date(star.created_at || 0)
  const date = isNaN(d) ? '—' : d.toLocaleDateString('zh-CN')
  const lvl = star.level ? esc(star.level) : '记忆'
  tt.innerHTML =
    `<div class="t-title">${esc(star.title || '无题')}</div>` +
    `<div class="t-meta">${lvl} · 重要度 ${star.importance ?? '—'} · ${date}</div>` +
    `<div class="t-text">${esc(star.text || '')}</div>`
  tt.classList.add('show')
  moveTooltip(mx, my)
}
function moveTooltip(mx, my) {
  const tt = document.getElementById('tooltip')
  if (!tt) return
  let x = mx + 16, y = my + 18
  const w = tt.offsetWidth, h = tt.offsetHeight
  if (x + w > window.innerWidth - 8) x = mx - w - 16
  if (y + h > window.innerHeight - 8) y = my - h - 16
  tt.style.left = x + 'px'; tt.style.top = y + 'px'
}
function hideTooltip() {
  const tt = document.getElementById('tooltip')
  if (tt) tt.classList.remove('show')
}

// ---------------------------------------------------------------------------
// 顶栏信息
// ---------------------------------------------------------------------------
function updateMeta(snapshot, usingMock) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v }
  set('meta-clusters', (snapshot.clusters || []).length)
  set('meta-stars', (snapshot.stars || []).length)
  const d = new Date(snapshot.generated_at || 0)
  set('meta-time', isNaN(d) ? '—' : d.toLocaleString('zh-CN', { hour12: false }))
  const tag = document.getElementById('meta-mode')
  if (tag) tag.textContent = usingMock ? '演示数据' : '实时'
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------
async function fetchSnapshot() {
  const r = await fetch('/api/constellation')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

function buildMock() {
  const clusterDefs = [
    { label: '学习笔记', count: 12, hue: 210 },
    { label: '项目工作', count: 11, hue: 285 },
    { label: '生活随想', count: 10, hue: 20 },
    { label: '灵感创意', count: 8, hue: 150 },
    { label: '健康运动', count: 7, hue: 340 },
    { label: '重要备忘', count: 6, hue: 48 },
  ]
  const clusters = [], stars = []
  clusterDefs.forEach((def, ci) => {
    const cid = 'mock_' + ci
    const u = (ci * 0.37 + 0.13) % 1
    const v = (ci * 0.61 + 0.27) % 1
    const phi = u * Math.PI * 2
    const theta = Math.acos(2 * v - 1)
    const radius = 230 + Math.sqrt(def.count) * 22
    const center = {
      x: +(radius * Math.sin(theta) * Math.cos(phi)).toFixed(2),
      y: +(radius * Math.cos(theta)).toFixed(2),
      z: +(radius * Math.sin(theta) * Math.sin(phi)).toFixed(2),
    }
    clusters.push({ cluster_id: cid, label: def.label, tags: [def.label], count: def.count, center })
    for (let i = 0; i < def.count; i++) {
      const t = ((ci * 13 + i * 7) % 100) / 100
      const arm = ((ci * 3 + i) % 3)
      const armOffset = (arm / 3) * Math.PI * 2
      const clusterR = 20 + Math.sqrt(def.count) * 7
      const rr = clusterR * Math.sqrt(t)
      const ang = armOffset + 4.5 * t + (((ci * 29 + i * 11) % 100) / 100) * 0.6
      const lx = rr * Math.cos(ang)
      const ly = rr * Math.sin(ang)
      const lz = ((((ci * 17 + i * 23) % 100) / 100) * 2 - 1) * clusterR * 0.18
      const importance = (i % 5) + 1
      const color = coldStarColor(importance)
      stars.push({
        memory_id: cid + '_' + i, cluster_id: cid,
        x: +(center.x + lx).toFixed(2), y: +(center.y + ly).toFixed(2), z: +(center.z + lz).toFixed(2),
        size: +(3 + importance * 1.6).toFixed(2), color,
        title: `${def.label} · 记忆 ${i + 1}`,
        text: `这是一条关于「${def.label}」的演示记忆（mock ${i + 1}）。悬停查看详情，点击可聚焦该星系，双击空白处回到全览视角。`,
        level: ['日常', '重要', '核心'][i % 3], importance,
        created_at: Date.now() - i * 86400000 - ci * 3600000,
      })
    }
  })
  return { schema_version: 3, generated_at: Date.now(), days: 90, limit: 500, total_memories: stars.length, clusters, stars }
}

function hslHex(h, s, l) {
  s /= 100; l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) }
  const to = (x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')
  return '#' + to(f(0)) + to(f(8)) + to(f(4))
}

async function load() {
  let data, usingMock = false
  try {
    data = await fetchSnapshot()
    if (!data || !Array.isArray(data.stars)) throw new Error('bad snapshot')
  } catch (_) {
    data = buildMock()
    usingMock = true
  }
  buildConstellation(data)
  updateMeta(data, usingMock)
  intro = { active: true, startT: performance.now(), fromPos: camera.position.clone(), toPos: defaultCamPos.clone() }
  hideOverlay()
}

function hideOverlay() {
  const ov = document.getElementById('overlay')
  if (ov) ov.classList.add('hidden')
}
function showError(msg) {
  const ov = document.getElementById('overlay')
  if (!ov) return
  ov.classList.remove('hidden')
  ov.innerHTML = `<div><div style="font-size:40px">⚠️</div><div>${msg}</div></div>`
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate)
  const now = performance.now()
  const tSec = now * 0.001

  // 1) 驱动所有星点呼吸（共用材质，更新一次 uTime 即可）
  starsMat.uniforms.uTime.value = tSec

  // 2) 背景星尘漂移
  if (bgGroup) {
    bgGroup.rotation.y += CFG.bgDriftSpeed
    bgGroup.rotation.x += CFG.bgDriftSpeed * 0.3
    bgGroup.traverse((o) => {
      if (o.userData && o.userData.isDust && o.material && o.material.uniforms) o.material.uniforms.uTime.value = tSec
    })
  }

  // 交互静止判定：悬停或聚焦时，暂停星系自转 + 全局公转，保证拾取/观察稳定
  const interactive = hoverIndex >= 0 || (focus && focus.active)

  // 3) 星系自转（绕盘面法线 rotateZ）
  if (!interactive) {
    clusterGroups.forEach((rec) => { rec.group.rotateZ(rec.spin) })
    // 4) 全局公转：所有星系绕原点主星缓慢公转
    constellationGroup.rotation.y += CFG.globalOrbitSpeed
  }

  // 5) 主星呼吸（三层光芒不同频率，自然脉动）
  if (coreStar) {
    const b = 1 + 0.08 * Math.sin(tSec * 1.1)
    coreStar.core.scale.setScalar(coreStar.core.userData.baseScale * b)
    coreStar.glow.scale.setScalar(coreStar.glow.userData.baseScale * (1 + 0.05 * Math.sin(tSec * 0.7)))
  }

  // 6) Star Chart 3D 文字：追踪世界坐标 + 动态明暗（含公转 / 自转）
  updateText3D()

  // 6b) 主星→星系连线随公转实时刷新（避免脱节）
  if (coreLinksActive) showCoreLinks()

  // 7) 相机：入场期间只由 intro lerp 驱动；入场结束后把控制权完全交还 OrbitControls
  //    —— 除 intro / focus 外，绝不在渲染循环里写 camera.position，OrbitControls 拥有绝对控制权
  if (intro && intro.active) {
    const t = Math.min(1, (now - intro.startT) / CFG.introDuration)
    const e = easeInOutCubic(t)
    camera.position.lerpVectors(intro.fromPos, intro.toPos, e)
    if (t >= 1) {
      intro.active = false
      controls.enabled = true
      controls.autoRotate = true
      controls.update()
    }
  } else {
    if (focus && focus.active) {
      camera.position.lerp(focus.camPos, 0.09)
      controls.target.lerp(focus.target, 0.09)
      if (camera.position.distanceTo(focus.camPos) < 0.6 && controls.target.distanceTo(focus.target) < 0.6) {
        focus.active = false
      }
    }
    controls.update()
  }

  composer.render()
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function start() {
  try { initThree() }
  catch (e) { showError('无法初始化 WebGL：' + (e && e.message ? e.message : e)); return }
  buildBackground()
  bindInteraction()
  animate()
  load().catch((e) => showError('加载失败：' + (e && e.message ? e.message : e)))
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
