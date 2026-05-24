import type { Admin, User } from "./types";

export function toAdmin(user: User): Admin {
    return { id: user.id, name2: user.name, role: "admin" };
}

export function toUser(admin: Admin): User {
    return { id: admin.id, name: admin.name2, surname: "" };
}