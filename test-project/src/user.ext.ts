import type { User, UserDto } from "./types";
import './user.ext';

export function toUserDto(user: User, newName?: string): UserDto {
    return { id: user.id, fullName: `${newName ?? user.name} ${user.surname}` };
}

export function toUser(userDto: UserDto): User {
    return { id: userDto.id, name: userDto.fullName.split(' ')[0], surname: userDto.fullName.split(' ')[1] };
}