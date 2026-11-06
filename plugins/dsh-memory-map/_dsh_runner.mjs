// DSH Web 保活包装器：
// 用完整用户 token 启动 DSH（绕过 cordis.yml 的 EPERM），同时用管道保持
// DSH 的 stdin 永不 EOF（避免 web 命令把 stdin 结束当成退出信号），
// 自身用 setInterval 保活。日志写入 dsh-runner.log。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LOG = path.join(os.tmpdir(), 'dsh-runner.log')
const log = (s) => { const line = `[${new Date().toISOString()}] ${s}\n`; try { fs.appendFileSync(LOG, line) } catch {}; process.stderr.write(line) }

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const ENV_FILE = 'C:\\Users\\user\\Desktop\\projects (2)\\dsh\\connection.env'
const BIN = 'C:\\Users\\user\\Desktop\\projects (2)\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const CWD = 'C:\\Users\\user\\Desktop\\projects (2)\\dsh'

log('runner starting')
const child = spawn(NODE, [
  `--env-file=${ENV_FILE}`,
  BIN,
  'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

child.stdout.on('data', (d) => { const s = d.toString(); log('OUT: ' + s.trimEnd()); process.stdout.write(d) })
child.stderr.on('data', (d) => { const s = d.toString(); log('ERR: ' + s.trimEnd()); process.stderr.write(d) })
child.on('error', (e) => log('spawn error: ' + e.message))
child.on('exit', (code, sig) => {
  log(`DSH exited code=${code} sig=${sig}`)
  // 不立即退出：给重启留观察，但这里直接退出让外层知道
  process.exit(code == null ? 0 : code)
})

// 关键：保持 stdin 管道打开，绝不调用 child.stdin.end()
log('stdin pipe kept open; runner keepalive started')
setInterval(() => {}, 1000) // 保活
