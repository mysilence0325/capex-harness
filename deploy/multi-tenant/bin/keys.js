#!/usr/bin/env node
/**
 * Generate the per-purpose keys, or say what is in effect.
 *
 * @module mt/bin/keys
 */

'use strict'

const path = require('node:path')
const { PURPOSES, readKeys, generateKeys } = require('../gateway/keys.js')

const root = path.resolve(__dirname, '..')
const stateDir = path.join(root, 'state')

if (process.argv.includes('--show')) {
  const keys = readKeys(stateDir)
  for (const purpose of PURPOSES) {
    const source = keys[purpose] === keys.legacy ? 'legacy registry.key' : 'keys.json'
    console.log(`  ${purpose.padEnd(9)} ${keys[purpose].slice(0, 6)}…  (${source})`)
  }
  process.exit(0)
}

const before = readKeys(stateDir)
generateKeys(stateDir)
const after = readKeys(stateDir)
const created = PURPOSES.filter((purpose) => before[purpose] !== after[purpose])
console.log(created.length === 0
  ? '  密钥已存在，未改动（state/keys.json）'
  : `  已生成 ${created.length} 把密钥 → state/keys.json（0600）`)
console.log('  用途: metrics 只读指标 / register 节点注册 / ops 宿主运维')
console.log('  旧 state/registry.key 仍然被接受，作为回退；确认各处都已换用新密钥后可以删除它。')
console.log('  用 --show 查看当前生效的密钥来源。')
