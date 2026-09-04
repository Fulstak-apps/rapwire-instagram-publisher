import test from 'node:test';
import assert from 'node:assert/strict';
import {hasPriorityArtist,priorityArtistsIn} from './artist-priority.mjs';
import {candidateScore} from './growth-feedback.mjs';

test('recognizes the configured priority artists without loose partial matches',()=>{
 assert.deepEqual(priorityArtistsIn('Playboi Carti and GloRilla link up.'),['Playboi Carti','GloRilla']);
 assert.equal(hasPriorityArtist('This is a future-facing label announcement.'),false);
 assert.equal(hasPriorityArtist('Future previews a new song.'),true);
});
test('priority artist boost affects ordering without replacing view ranking',()=>{
 const base={source:{handle:'test'},viewCount:1_000,profilePosition:0};
 assert.ok(candidateScore({...base,priorityArtists:['Drake']},{})>candidateScore(base,{}));
});
