import {User, UserDto} from "./types";

export function toUserDto(user: User, newId: string, newName: string | undefined): UserDto {
    return { id: newId, fullName: user.name + " " + user.surname + newName};
}

type Admin = { id: string; name2: string };

export function toAdmin(user: User): Admin {
    return { id: user.id, name2: user.name };
}