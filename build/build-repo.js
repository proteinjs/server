/*! For license information please see build-repo.js.LICENSE.txt */
            const ${"_superIndex"} = name => super[name];`},hE={name:"typescript:advanced-async-super",scoped:!0,text:xE`
            const ${"_superIndex"} = (function (geti, seti) {
                const cache = Object.create(null);
                return name => cache[name] || (cache[name] = { get value() { return geti(name); }, set value(v) { seti(name, v); } });