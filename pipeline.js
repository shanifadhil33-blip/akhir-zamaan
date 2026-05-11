// pipeline.js
// Main orchestrator — runs one full video generation per invocation.
// Stages:
//   1. Topic picker + auto-refill check
//   2. Source retrieval (Quran + hadith from local files)
//   3. Modern context (Ollama gpt-oss:120b-cloud)
//   4. Script generation (Ollama gpt-oss:120b-cloud)
//   5. Visual plan (Ollama gpt-oss:120b-cloud)
//   6. Parallel: voiceover + images + recitations + thumbnail
//   7. Captions (SRT + ASS from TTS word timings)
//   8. FFmpeg video assembly
//   9. Thumbnail assembly
//  10. Metadata write + mark topic as generated
// Final .mp4 is delivered to the operator via the GitHub Actions workflow
// (curl upload to bashupload.com + Telegram link). Manual upload to YouTube.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const queue = require('./modules/queue');
const topicGen = require('./modules/topic-generator');
const sources = require('./modules/source-retriever');
const modernCtx = require('./modules/modern-context');
const research = require('./modules/research');
const llm = require('./modules/llm');
const voiceover = require('./modules/voiceover');
const recitation = require('./modules/recitation');
const images = require('./modules/images');
const captions = require('./modules/captions');
const assembler = require('./modules/assembler');
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

    // STAGE 3: Modern context — real web research via Tavily, fall back
    // to LLM-only training-knowledge if Tavily isn't configured / failed.
    stage = '3_modern_context';
    let modern = null;
    if (research.tavilyConfigured()) {
      try {
        modern = await research.researchTopic(topic);
      } catch (e) {
        console.warn(`[pipeline] research failed: ${e.message} — falling back to LLM-only modern context`);
      }
    }
    if (!modern) {
      modern = await modernCtx.getModernContext(topic);
      modern._source = modern._source || 'ollama-training';
    }
    writeArtifact(outputDir, 'modern-context.json', modern);
    console.log(`[pipeline] modern context (${modern._source || 'unknown'}): ${(modern.events || []).length} events, ${(modern.patterns || []).length} patterns`);

    // STAGE 4: Script generation
    stage = '4_script';
    const script = await llm.generateScript({
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
    const visualPlan = await llm.generateVisualPlan({ script });
    writeArtifact(outputDir, 'visual-plan.json', visualPlan);
    console.log(`[pipeline] visual plan: ${visualPlan.beats.length} beats`);

    // STAGE 6: Parallel generation — voiceover + images.
    // Quran Arabic recitations were removed at the operator's request — they
    // were disrupting the narrative flow. The English voiceover carries the
    // whole video. The recitation module + assembler overlay code is left
    // intact in case the decision reverses, but for now no audio overlays.
    stage = '6_parallel_gen';
    console.log('[pipeline] starting parallel generation...');
    const [voiceRes, beatsRes] = await Promise.all([
      voiceover.generateVoiceover(script, outputDir),
      images.generateAllBeats(visualPlan, outputDir),
    ]);
    const recitationRes = []; // No Arabic recitations — English voiceover only
    writeArtifact(outputDir, 'recitations.json', recitationRes);
    console.log(`[pipeline] voice: ${voiceRes.wordTimings.length} words, beats: ${beatsRes.length}, recitations: 0 (disabled)`);

    // STAGE 6b: Thumbnail background (after beats — uses first beat as fallback)
    stage = '6b_thumbnail_bg';
    const thumbRes = await images.generateThumbnail(visualPlan, outputDir);
    if (!thumbRes.bgPath) {
      const fallbackBeat = beatsRes.find((b) => b && b.imagePath && fs.existsSync(b.imagePath));
      if (fallbackBeat) {
        thumbRes.bgPath = fallbackBeat.imagePath;
        console.log(`[pipeline] thumbnail bg unavailable; reusing ${path.basename(fallbackBeat.imagePath)}`);
      } else {
        throw new Error('thumbnail bg failed and no beat image is available as fallback');
      }
    }

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

    // STAGE 10: Metadata + mark topic as generated
    // YouTube upload removed — final .mp4 is delivered out-of-band by the
    // GitHub Actions workflow (bashupload + Telegram). Mark the topic as
    // published once the video file is on disk so we don't re-generate it
    // on the next run; manual YouTube upload happens after delivery.
    stage = '10_metadata';
    const metadata = await llm.generateMetadata({ script, visualPlan, sources: srcData, topic });
    writeArtifact(outputDir, 'metadata.json', metadata);

    const relVideoPath = path.relative(__dirname, asmRes.videoPath).replace(/\\/g, '/');
    queue.markPublished(topic, null, relVideoPath);
    writeArtifact(outputDir, 'delivery.json', {
      videoPath: relVideoPath,
      thumbnailPath: path.relative(__dirname, thumbPath).replace(/\\/g, '/'),
      srtPath: path.relative(__dirname, capPaths.srtPath).replace(/\\/g, '/'),
      durationSec: asmRes.durationSec,
      title: metadata.title,
      generatedAt: new Date().toISOString(),
    });

    console.log(`[pipeline] DONE — video ready: ${asmRes.videoPath}`);
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
