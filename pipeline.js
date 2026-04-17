// pipeline.js
// Main orchestrator — runs one full video generation + upload per invocation.
// Stages:
//   1. Topic picker + auto-refill check
//   2. Source retrieval (Quran + hadith from local files)
//   3. Modern context (Gemini grounded search)
//   4. Script generation (Gemini 2.5 Pro)
//   5. Visual plan (Gemini 2.5 Flash)
//   6. Parallel: voiceover + images + recitations + thumbnail
//   7. Captions (SRT + ASS from TTS word timings)
//   8. FFmpeg video assembly
//   9. Thumbnail assembly
//  10. Metadata + YouTube upload + Short + pinned comment
// Marks topic as published only after successful upload.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const queue = require('./modules/queue');
const topicGen = require('./modules/topic-generator');
const sources = require('./modules/source-retriever');
const modernCtx = require('./modules/modern-context');
const gemini = require('./modules/gemini');
const voiceover = require('./modules/voiceover');
const recitation = require('./modules/recitation');
const images = require('./modules/images');
const captions = require('./modules/captions');
const assembler = require('./modules/assembler');
const shorts = require('./modules/shorts');
const youtube = require('./modules/youtube');
const notify = require('./modules/notify');

const OUTPUT_ROOT = path.join(__dirname, 'output');
const DRY_RUN = process.argv.includes('--dry-run');

function slugify(s) {
  return String(s || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function timestamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}_${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function writeArtifact(dir, name, data) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

async function main() {
  let stage = 'init';
  let topic = null;
  let outputDir = null;

  try {
    if (!fs.existsSync(OUTPUT_ROOT)) fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

    // STAGE 1: Topic + auto-refill
    stage = '1_topic';
    try {
      await topicGen.refillIfLow();
    } catch (e) {
      console.warn('[pipeline] topic-gen refill error (continuing):', e.message);
    }
    const pick = queue.getNextTopic();
    if (!pick.topic) {
      console.error('[pipeline] topics queue exhausted and auto-refill did not produce results');
      await notify.notifyError({ stage, error: new Error('Topic queue empty'), topic: null });
      process.exit(2);
    }
    topic = pick.topic;
    const nextTopic = pick.next;
    console.log(`[pipeline] topic: ${topic.id} — ${topic.title}`);
    console.log(`[pipeline] queue remaining: ${pick.remaining}`);

    // Create output dir for this video
    outputDir = path.join(OUTPUT_ROOT, `${timestamp()}_${slugify(topic.title)}`);
    fs.mkdirSync(outputDir, { recursive: true });
    writeArtifact(outputDir, 'topic.json', topic);

    // STAGE 2: Sources
    stage = '2_sources';
    const srcData = await sources.retrieveForTopic(topic);
    writeArtifact(outputDir, 'sources.json', srcData);
    console.log(`[pipeline] sources: ${srcData.verses.length} verses, ${srcData.hadith.length} hadith`);

    // STAGE 3: Modern context
    stage = '3_modern_context';
    const modern = await modernCtx.getModernContext(topic);
    writeArtifact(outputDir, 'modern-context.json', modern);
    console.log(`[pipeline] modern context: ${modern.length} events`);

    // STAGE 4: Script generation
    stage = '4_script';
    const script = await gemini.generateScript({
      topic,
      sources: srcData,
      modernContext: modern,
      nextTopic,
    });
    writeArtifact(outputDir, 'script.json', script);
    console.log(`[pipeline] script generated: ${(script.cold_open || '').length + (script.naming || '').length + (script.excavation || '').length + (script.mirror || '').length + (script.haunting || '').length} chars total`);

    if (DRY_RUN) {
      console.log('[pipeline] DRY RUN complete — stopping after script generation');
      console.log(`Output: ${outputDir}`);
      return;
    }

    // STAGE 5: Visual plan
    stage = '5_visual_plan';
    const visualPlan = await gemini.generateVisualPlan({ script });
    writeArtifact(outputDir, 'visual-plan.json', visualPlan);
    console.log(`[pipeline] visual plan: ${visualPlan.beats.length} beats`);

    // STAGE 6: Parallel generation — voiceover, images, recitations, thumbnail bg
    stage = '6_parallel_gen';
    console.log('[pipeline] starting parallel generation...');
    const [voiceRes, beatsRes, recitationRes, thumbRes] = await Promise.all([
      voiceover.generateVoiceover(script, outputDir),
      images.generateAllBeats(visualPlan, outputDir),
      recitation.downloadAllRecitations(script.verses_for_recitation || [], outputDir),
      images.generateThumbnail(visualPlan, outputDir),
    ]);
    writeArtifact(outputDir, 'recitations.json', recitationRes);
    console.log(`[pipeline] voice: ${voiceRes.wordTimings.length} words, beats: ${beatsRes.length}, recitations: ${recitationRes.length}`);

    // STAGE 7: Captions
    stage = '7_captions';
    const capPaths = captions.writeCaptions(voiceRes.wordTimings, outputDir);
    console.log(`[pipeline] captions: ${capPaths.srtPath}, ${capPaths.assPath}`);

    // STAGE 8: Video assembly
    stage = '8_assemble_video';
    const asmRes = await assembler.assembleVideo({
      beats: beatsRes,
      audioPath: voiceRes.audioPath,
      captionsAss: capPaths.assPath,
      recitations: recitationRes,
      outputDir,
    });
    console.log(`[pipeline] video assembled: ${asmRes.videoPath} (${asmRes.durationSec.toFixed(1)}s)`);

    // STAGE 9: Thumbnail
    stage = '9_thumbnail';
    const thumbPath = assembler.assembleThumbnail(thumbRes, outputDir);
    console.log(`[pipeline] thumbnail: ${thumbPath}`);

    // STAGE 10: Metadata + upload + short + pinned comment
    stage = '10_metadata_upload';
    const metadata = await gemini.generateMetadata({ script, visualPlan, sources: srcData, topic });
    writeArtifact(outputDir, 'metadata.json', metadata);

    const uploadRes = await youtube.uploadVideo({
      videoPath: asmRes.videoPath,
      thumbnailPath: thumbPath,
      srtPath: capPaths.srtPath,
      metadata,
    });
    console.log(`[pipeline] uploaded: ${uploadRes.url}`);

    // Pinned comment
    if (script.pinned_comment_question) {
      await youtube.postPinnedComment(uploadRes.videoId, script.pinned_comment_question);
    }

    // Short
    const shortsEnabled = String(process.env.SHORTS_ENABLED || 'true') === 'true';
    if (shortsEnabled) {
      try {
        stage = '10b_short';
        const shortRes = await shorts.generateShort({
          videoPath: asmRes.videoPath,
          visualPlan,
          beats: beatsRes,
          outputDir,
        });
        const shortMeta = shorts.buildShortMetadata({
          mainTitle: metadata.title,
          mainDescription: metadata.description,
          shortsSegmentReason: visualPlan.shorts_segment && visualPlan.shorts_segment.reason,
        });
        const shortUpload = await youtube.uploadVideo({
          videoPath: shortRes.shortPath,
          thumbnailPath: null,
          srtPath: null,
          metadata: {
            title: shortMeta.title,
            description: shortMeta.description,
            tags: shortMeta.tags,
            category_id: 27,
            default_language: 'en',
            default_audio_language: 'en',
          },
          isShort: true,
        });
        console.log(`[pipeline] short uploaded: ${shortUpload.url}`);
        writeArtifact(outputDir, 'short-upload.json', shortUpload);
      } catch (shortErr) {
        console.warn('[pipeline] short generation/upload failed (non-fatal):', shortErr.message);
      }
    }

    // Mark published ONLY after successful main upload
    queue.markPublished(topic, uploadRes.videoId, uploadRes.url);
    writeArtifact(outputDir, 'upload.json', uploadRes);

    console.log('[pipeline] DONE');
  } catch (err) {
    console.error(`[pipeline] FAILED at stage ${stage}:`, err);
    try {
      await notify.notifyError({ stage, error: err, topic });
    } catch (e) {
      // swallow
    }
    process.exit(1);
  }
}

main();
