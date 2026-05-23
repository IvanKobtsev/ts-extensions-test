import {User} from "./types";
import './new.ext';
import './user.ext';

const user: User = { id: "a1", name: "John", surname: "Smith" };

user.toAdmin();
user.toUserDto();