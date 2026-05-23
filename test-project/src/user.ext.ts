import {User, UserDto} from "./types";

type Admin = { id: string; name2: string };

export function toAdmin(user: User): Admin {
    return { id: user.id, name2: user.name };
}