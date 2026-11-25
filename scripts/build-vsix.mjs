#!/usr/bin/env node
/**
 * Build the VS Code / Cursor extension VSIX without any dependency.
 *
 * A VSIX is an OPC/zip package holding `[Content_Types].xml`, `extension.vsixmanifest`
 * and the extension payload under `extension/`. This writer uses Node's zlib only, so
 * `npm run build:vsix` works on a bare machine.
 */
import { deflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = join(root, 'extension')
const manifest = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'))
const vsixPath = join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`)
const stagingName = `${vsixPath}.${process.pid}.tmp`

/** Escape one XML attribute or text node. */
function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".xml" ContentType="text/xml"/>
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml"/>
</Types>
`

function vsixManifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}" />
    <DisplayName>${xml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description)}</Description>
    <Tags>dsh,mirror,harness</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines && manifest.engines.vscode ? manifest.engines.vscode : '^1.85.0')}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 of one buffer. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS date/time for one Date. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

/** Build a zip archive from `{ name, data }` entries. */
function createZip(entries) {
  const parts = []
  const centralParts = []
  const stamp = dosDateTime(new Date())
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBytes, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }
  const centralBuffer = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, centralBuffer, end])
}

const files = [
  { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
  { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest(), 'utf8') },
  { name: 'extension/package.json', data: readFileSync(join(extensionDir, 'package.json')) },
  { name: 'extension/extension.js', data: readFileSync(join(extensionDir, 'extension.js')) },
  { name: 'extension/README.md', data: readFileSync(join(extensionDir, 'README.md')) },
]

mkdirSync(dirname(vsixPath), { recursive: true })
writeFileSync(stagingName, createZip(files))
renameSync(stagingName, vsixPath)
console.log(`VSIX written: ${vsixPath} (${files.length} entries)`)
