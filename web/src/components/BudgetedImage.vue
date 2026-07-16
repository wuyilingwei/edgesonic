<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { runLowPriority } from "../lib/requestBudget";

defineOptions({ inheritAttrs: false });

const props = defineProps<{ src: string; alt: string }>();
const emit = defineEmits<{ error: [] }>();
const loadedSrc = ref<string>();
const imageEl = ref<HTMLImageElement>();
let observer: IntersectionObserver | null = null;
let cancelled = false;

function loadImage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = imageEl.value;
    if (!image) {
      reject(new Error("image element unavailable"));
      return;
    }
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("image load failed"));
    };
    const cleanup = () => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };
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
});
</script>

<template>
  <img ref="imageEl" v-bind="$attrs" :src="loadedSrc" :alt="alt" />
</template>
