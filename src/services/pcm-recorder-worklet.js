// AudioWorkletProcessor that captures mono Float32 PCM from the microphone input
// and posts each 128-sample render quantum back to the main thread.
//
// This is the modern, mobile-reliable replacement for ScriptProcessorNode:
// ScriptProcessorNode's `onaudioprocess` callback does NOT fire reliably on
// Android Chrome / Huawei browsers, which caused the cloud ASR to silently
// produce an empty WAV (the original "Transcribing → nothing" bug). AudioWorklet
// runs on the dedicated audio render thread and is well supported on mobile.

class PcmRecorderProcessor extends AudioWorkletProcessor {
  /**
   * @param {Float32Array[][]} inputs - inputs[inputIndex][channelIndex] = Float32Array(128)
   * @returns {boolean} true to keep the processor alive across quanta.
   */
  process(inputs) {
    const input = inputs && inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Copy channel 0 (mono). The underlying buffer is reused by the audio
      // thread every quantum, so we must clone before posting to the main thread.
      this.port.postMessage(input[0].slice(0));
    }
    return true; // keep processor running
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
