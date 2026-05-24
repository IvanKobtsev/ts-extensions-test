import { User } from "./types";
import './user.ext';

const user: User = { id: "a1", name: "John", surname: "Smith" };
const chainedUser = user.toAdmin().toUser();
const user2 = chainedUser.toUserDto();

console.log('%c[ext] user', 'color:#569cd6;font-weight:bold', user);
console.log('%c[ext] user.toAdmin()', 'color:#569cd6;font-weight:bold', user.toAdmin());
console.log('%c[ext] chainedUser (toAdmin → toUser)', 'color:#569cd6;font-weight:bold', chainedUser);
console.log('%c[ext] user2 = chainedUser.toUserDto()', 'color:#569cd6;font-weight:bold', user2);
