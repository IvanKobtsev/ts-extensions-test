import {User, UserDto} from "./types";

export function toUserDto(user:User): UserDto {
    return { id: user.id, fullName: user.name };
}