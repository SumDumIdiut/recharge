import test from 'node:test';
import assert from 'node:assert/strict';
import { countsText, placeholderKind } from '../src/backgrounds/media.js';

test('countsText: per kind, singular/plural, zero kinds omitted, empty', () => {
  assert.equal(countsText(['a.png', 'b.jpg', 'c.mp4', 'd.mp3']), '2 pictures · 1 video · 1 sound');
  assert.equal(countsText(Array.from({ length: 34 }, (_, i) => `${i}.png`).concat(['x.mp4', 'y.webm', 's.wav'])), '34 pictures · 2 videos · 1 sound');
  assert.equal(countsText(['a.gif']), '1 picture');
  assert.equal(countsText(['a.mp4']), '1 video');
  assert.equal(countsText(['a.ogg', 'b.mp3']), '2 sounds');
  assert.equal(countsText(['notes.txt']), 'empty');
  assert.equal(countsText([]), 'empty');
  assert.equal(countsText(undefined), 'empty');
});

test('placeholderKind: only when there is no picture', () => {
  assert.equal(placeholderKind(['a.png', 'b.mp4']), null);
  assert.equal(placeholderKind(['b.mp4', 's.mp3']), 'video');
  assert.equal(placeholderKind(['s.mp3']), 'audio');
  assert.equal(placeholderKind([]), null);
});
