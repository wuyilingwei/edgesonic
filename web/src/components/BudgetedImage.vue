<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { runLowPriority } from "../lib/requestBudget";

defineOptions({ inheritAttrs: false });

const props = defineProps<{ src: string; alt: string }>();
const emit = defineEmits<{ error: [] }>();
const LOAD_TIMEOUT_MS = 20 * 1000;
const loadedSrc = ref<string>();
const imageEl = ref<HTMLImageElement>();
let observer: IntersectionObserver | null = null;
let cancelled = false;
let releaseLoad: (() => void) | null = null;

function loadImage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = imageEl.value;
    if (!image || cancelled) {
      resolve();
      return;
    }
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      releaseLoad = null;
      settle();
    };
    const onLoad = () => finish(resolve);
    const onError = () => finish(() => reject(new Error("image load failed")));
    // Unmounting or stalling must hand the shared budget slot back, otherwise
    // one pending image can starve every other queued request.
    releaseLoad = () => finish(resolve);
    timer = setTimeout(() => finish(() => reject(new Error("image load timed out"))), LOAD_TIMEOUT_MS);
    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
    loadedSrc.value = props.src;
  });
}

function load(): void {
  void runLowPriority(loadImage).catch(() => {
    if (!cancelled) emit("error");
  });
}

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") {
    load();
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries[0]?.isIntersecting) return;
    observer?.disconnect();
    observer = null;
    load();
  }, { rootMargin: "240px" });
  if (imageEl.value) observer.observe(imageEl.value);
});

onBeforeUnmount(() => {
  cancelled = true;
  observer?.disconnect();
  releaseLoad?.();
});
</script>

<template>
  <img ref="imageEl" v-bind="$attrs" :src="loadedSrc" :alt="alt" />
</template>
