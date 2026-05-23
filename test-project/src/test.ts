import {User} from "./types";
import './new.ext';

const user: User = { id: "a1", name: "John", surname: "Smith" };

user.toUserDto();