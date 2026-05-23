import {User} from "./types";
import { toUserDto } from './user.ext';
import { toAdmin } from './user.ext';

const user: User = { id: "a1", name: "John", surname: "Smith" };

user.toUserDto("123", "123");

user.toUserDto("123", "new Name");

user.toAdmin()