// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAuth, parseXmlAttrs } from "../api";

const { isAdmin, isSuperAdmin, authFetch, authPost } = useAuth();
const users = ref<Array<{ username: string; level: number; enabled: boolean }>>([]);
const showForm = ref(false);
const form = ref({ username: "", password: "", level: 1 });
const editingUser = ref("");
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

const levelLabels: Record<number, string> = { 0: "Guest", 1: "User", 2: "Admin", 3: "Super Admin" };
const levelColors: Record<number, string> = { 0: "badge-red", 1: "badge-green", 2: "badge-blue", 3: "badge-yellow" };

async function load() {
  try {
    const xml = await authFetch("getUsers");
    users.value = parseXmlAttrs(xml, "user").map((u) => ({
      username: u.username || "", level: parseInt(u.level || "1"),
      enabled: u.enabled === "1" || u.enabled === "true",
    }));
  } catch { users.value = []; }
}

async function addUser() {
  try { await authPost("createUser", form.value); showForm.value = false; form.value = { username: "", password: "", level: 1 }; load(); showToast("User created"); }
  catch { showToast("Failed to create user", "error"); }
}

async function updateUser(user: { username: string; level?: number; enabled?: number }) {
  try { await authPost("updateUser", user); load(); showToast("User updated"); }
  catch { showToast("Failed to update", "error"); }
}

async function deleteUser(username: string) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try { await authPost("deleteUser", { username }); load(); showToast("User deleted"); }
  catch { showToast("Failed to delete", "error"); }
}

function toggleEnabled(u: { username: string; enabled: boolean }) {
  updateUser({ username: u.username, enabled: u.enabled ? 0 : 1 });
}

function changeLevel(u: { username: string; level: number }, newLevel: number) {
  updateUser({ username: u.username, level: newLevel });
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">Users</h1>
      <button v-if="isAdmin" class="btn btn-primary" @click="showForm = !showForm">{{ showForm ? "Cancel" : "+ Add User" }}</button>
    </div>

    <div v-if="showForm" class="card" style="margin-bottom:20px; max-width:450px">
      <div class="card-header"><span class="card-title">New User</span></div>
      <div style="display:flex; flex-direction:column; gap:12px">
        <div class="form-group"><label class="form-label">Username</label><input v-model="form.username" class="form-input" /></div>
        <div class="form-group"><label class="form-label">Password</label><input v-model="form.password" type="password" class="form-input" /></div>
        <div class="form-group">
          <label class="form-label">Level</label>
          <select v-model="form.level" class="form-select">
            <option v-if="isSuperAdmin" :value="3">3 — Super Admin</option>
            <option :value="2">2 — Admin</option>
            <option :value="1">1 — User</option>
            <option :value="0">0 — Guest</option>
          </select>
        </div>
        <button class="btn btn-primary" @click="addUser">Create User</button>
      </div>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>Username</th><th>Level</th><th>Status</th><th style="width:120px">Actions</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.username">
            <td><span class="user-name">{{ u.username }}</span></td>
            <td>
              <select v-if="isSuperAdmin" :value="u.level" @change="changeLevel(u, parseInt(($event.target as HTMLSelectElement).value))" class="form-select level-select">
                <option :value="3">Super Admin</option><option :value="2">Admin</option><option :value="1">User</option><option :value="0">Guest</option>
              </select>
              <span v-else :class="['badge', levelColors[u.level] || 'badge-blue']">{{ levelLabels[u.level] || u.level }}</span>
            </td>
            <td>
              <span :class="['badge', u.enabled ? 'badge-green' : 'badge-red']" style="cursor:pointer" @click="toggleEnabled(u)">{{ u.enabled ? "Active" : "Disabled" }}</span>
            </td>
            <td>
              <button v-if="isAdmin" class="btn btn-danger btn-sm" @click="deleteUser(u.username)">Delete</button>
            </td>
          </tr>
          <tr v-if="!users.length"><td colspan="4" style="text-align:center; color:var(--text-muted); padding:24px">No users found.</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.page { max-width: 900px; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.page-title { font-size: 20px; font-weight: 700; }
.user-name { font-weight: 600; font-size: 13px; }
.level-select { display: inline-block; width: auto; padding: 4px 8px; font-size: 12px; }
</style>
