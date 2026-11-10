import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePin, normalizeCandidates, verifySinglePinSave } from '../pins.mjs';

const pin = (id = '1042794488735725501') => ({
  pinId: id, pinUrl: 'https://ru.pinterest.com/pin/' + id + '/?x=1',
  imageUrl: 'https://i.pinimg.com/474x/ab/cd/example.jpg', alt: 'Bench', width: 237, height: 421
});
test('keeps large Pinterest IDs losslessly and canonicalizes regional links', () => {
  const result = normalizePin(pin());
  assert.equal(result.pinId, '1042794488735725501');
  assert.equal(result.pinUrl, 'https://www.pinterest.com/pin/1042794488735725501/');
});
test('rejects deceptive source hosts and credentials', () => {
  for (const url of ['https://pinterest.com.evil.test/pin/123/', 'https://pinterest.com@evil.test/pin/123/']) {
    assert.throws(() => normalizePin({ ...pin('123'), pinUrl: url }));
  }
});
test('rejects mismatching pin identity', () => {
  assert.throws(() => normalizePin({ ...pin('123'), pinId: '456' }), /mismatch/);
});
test('does not allow arbitrary image fetch destinations', () => {
  for (const imageUrl of ['http://i.pinimg.com/a.jpg', 'https://i.pinimg.com.evil.test/a.jpg', 'https://127.0.0.1/a.jpg']) {
    assert.throws(() => normalizePin({ ...pin(), imageUrl }));
  }
});
test('deduplicates IDs while accounting for invalid records', () => {
  const result = normalizeCandidates([pin(), pin(), { ...pin('123'), imageUrl: 'data:image/png;base64,AAAA' }]);
  assert.equal(result.pins.length, 1);
  assert.equal(result.rejected.length, 1);
});
test('whitelists evidence fields and handles unloaded images', () => {
  const result = normalizePin({ ...pin(), cookies: 'must-not-copy', token: 'must-not-copy', width: 0, height: 0 });
  assert.equal(result.observedWidth, null);
  assert.equal(result.observedHeight, null);
  assert.equal('cookies' in result, false);
  assert.equal('token' in result, false);
});

test('save readback preserves original identity when Pinterest assigns a new ID', () => {
 const image='https://i.pinimg.com/1200x/64/f2/f8/64f2f84724c4d5f6952d4d41ae1ed627.jpg';
 const original={...pin('100000000000000001'),imageUrl:image};
 const saved={...pin('200000000000000002'),imageUrl:image.replace('/1200x/','/474x/')};
 const receipt=verifySinglePinSave(original,[saved]);
 assert.equal(receipt.sourcePinId,'100000000000000001');
 assert.equal(receipt.savedPinId,'200000000000000002');
});
test('does not accept a different or ambiguous saved image', () => {
 const original={...pin('123'),imageUrl:'https://i.pinimg.com/474x/64/f2/f8/64f2f84724c4d5f6952d4d41ae1ed627.jpg'};
 const wrong={...pin('456'),imageUrl:'https://i.pinimg.com/474x/00/00/00/00000000000000000000000000000000.jpg'};
 assert.throws(()=>verifySinglePinSave(original,[wrong]),/differs/);
 assert.throws(()=>verifySinglePinSave(original,[original,wrong]),/Ambiguous/);
});
