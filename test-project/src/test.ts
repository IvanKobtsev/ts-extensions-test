import { User } from "./types";
import './user.ext';
import './user2.ext';


const user: User = { id: "1", name: "John", surname: "Doe" };

const userDto = user.toUserDto("asdasdas");

const userDto2 = userDto.toUserDto();

console.log(user, userDto, userDto2);