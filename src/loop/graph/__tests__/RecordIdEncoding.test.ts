/**
 * Record ids must survive being used as file names on every platform.
 *
 * `commitKey` is `${activationId}:${continuationVersion}`. On NTFS `:` opens an
 * alternate data stream, so `act-<uuid>:0.json` writes a stream named `0.json`
 * ON the file `act-<uuid>` instead of creating a file. `readdir` does not
 * enumerate streams, so `listJsonIds` came back empty, `listPreparedIntents`
 * found nothing, and crash recovery was a silent no-op on Windows: no error
 * anywhere, just a durability guarantee that quietly did not hold.
 */
import { describe, expect, it } from 'vitest'
import { encodeRecordId } from '../runtime/GraphStore.js'

describe('encodeRecordId', () => {
  it('escapes the separator that breaks Windows file names', () => {
    const encoded = encodeRecordId('act-2f1c:0')
    expect(encoded).not.toContain(':')
    expect(encoded).toBe('act-2f1c%3A0')
  })

  it('leaves already-safe ids byte-identical so existing files still resolve', () => {
    // The encoding must be a no-op on the ids used everywhere else, or this
    // change would orphan every record written before it.
    for (const id of ['act-9f8e7d6c-1234-4321-abcd-000011112222', 'plain', 'a.b_c-d', '000000000042']) {
      expect(encodeRecordId(id)).toBe(id)
    }
  })

  it('is injective across the characters that collide under naive sanitising', () => {
    // Replacing unsafe characters with a single filler (the obvious fix) maps
    // distinct keys onto one file and silently merges two commit intents.
    const encoded = [':', '/', '\\', '*', '?', '"', '<', '>', '|', ' '].map(ch => encodeRecordId(`k${ch}1`))
    expect(new Set(encoded).size).toBe(encoded.length)
  })

  it('produces names free of every character Windows rejects', () => {
    const encoded = encodeRecordId('act-1:2/3\\4*5?6"7<8>9|10')
    expect(/^[A-Za-z0-9._%-]+$/.test(encoded)).toBe(true)
  })
})
