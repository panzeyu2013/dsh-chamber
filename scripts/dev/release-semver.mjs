import { pathToFileURL } from 'node:url'

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseReleaseVersion(version) {
  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`invalid canonical release version: ${version}`)
  const prerelease = match[4]?.split('.') ?? []
  for (const identifier of prerelease) {
    if (/^[0-9]+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(`numeric prerelease identifier has a leading zero: ${identifier}`)
    }
  }
  if (prerelease.length !== 0
    && (prerelease.length !== 2 || prerelease[0] !== 'beta' || !/^(0|[1-9][0-9]*)$/.test(prerelease[1]))) {
    throw new Error(`unsupported release prerelease: ${version} (only X.Y.Z-beta.N is publishable)`)
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  }
}

function compareIdentifier(left, right) {
  const leftNumeric = /^[0-9]+$/.test(left)
  const rightNumeric = /^[0-9]+$/.test(right)
  if (leftNumeric && rightNumeric) {
    const a = BigInt(left)
    const b = BigInt(right)
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] < b.core[index]) return -1
    if (a.core[index] > b.core[index]) return 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const width = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < width; index += 1) {
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1
    const result = compareIdentifier(a.prerelease[index], b.prerelease[index])
    if (result !== 0) return result
  }
  return 0
}

export function releaseChannel(version) {
  return parseReleaseVersion(version).prerelease.length === 0 ? 'latest' : 'beta'
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , command, ...args] = process.argv
  try {
    if (command === 'channel' && args.length === 1) {
      process.stdout.write(releaseChannel(args[0]))
    } else if (command === 'compare' && args.length === 2) {
      process.stdout.write(String(compareReleaseVersions(args[0], args[1])))
    } else {
      throw new Error('usage: release-semver.mjs channel <version> | compare <left> <right>')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
