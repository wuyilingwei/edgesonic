<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAuth } from "../api";

const { isAdmin, authFetch } = useAuth();
const users = ref<Array<{ username: string; level: number; enabled: boolean }>>([]);
const showForm = ref(false);
const form = ref({ username: "", password: "", level: 1 });

async function load() {
  const xml = await authFetch("getUsers");
  const items: typeof users.value = [];
  const re = /<user\s+([^>]+)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    items.push({
      username: m[1].match(/username="([^"]+)"/)?.[1] || "",
      level: parseInt(m[1].match(/level="(\d+)"/)?.[1] || "0"),
      enabled: m[1].match(/enabled="(\d+)"/)?.[1] === "1",
    });
  }
  users.value = items;
}

async function addUser() {
  await authFetch("createUser", form.value);
  showForm.value = false;
  load();
}

const levelNames = ["Guest", "User", "Admin", "Super Admin"];

onMounted(load);
</script>

<template>
  <div>
    <h1 style="margin-bottom:16px">Users</h1>
    <button v-if="isAdmin" @click="showForm = !showForm" class="btn">{{ showForm ? "Cancel" : "Add User" }}</button>

    <div v-if="showForm" class="form-panel">
      <input v-model="form.username" placeholder="Username" />
      <input v-model="form.password" type="password" placeholder="Password" />
      <select v-model="form.level">
        <option :value="1">User</option>
        <option :value="2">Admin</option>
        <option :value="3">Super Admin</option>
      </select>
      <button @click="addUser" class="btn primary">Save</button>
    </div>

    <div class="list">
      <div v-for="u in users" :key="u.username" class="card">
        <div class="card-title">{{ u.username }} <span class="level">{{ levelNames[u.level] || "Unknown" }}</span></div>
        <div class="card-meta">{{ u.enabled ? "Active" : "Disabled" }}</div>
      </div>
      <p v-if="users.length === 0" class="empty">No users.</p>
    </div>
  </div>
</template>

<style scoped>
.btn { padding: 8px 16px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; font-size: 13px; margin-bottom: 16px; }
.btn:hover { background: #30363d; }
.btn.primary { background: #238636; border-color: #238636; }
.form-panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 10px; max-width: 400px; }
.form-panel input, .form-panel select { padding: 8px 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 16px; }
.card-title { font-weight: 600; font-size: 14px; }
.card-meta { font-size: 12px; color: #8b949e; margin-top: 4px; }
.level { background: #1f6feb22; color: #58a6ff; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-left: 8px; }
.empty { color: #8b949e; font-size: 13px; margin-top: 16px; }
</style>
