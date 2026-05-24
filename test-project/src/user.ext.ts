import type { User } from "./types";

export type Admin = { id: string; name2: string, role: string };

export function toAdmin(user: User): Admin {
    return { id: user.id, name2: user.name, role: "admin" };
}

export function toUser(admin: Admin): User {
    return { id: admin.id, name: admin.name2, surname: "" };
}