# Dogfood: greeting file and output format

Plan exactly two tasks, in this order. The tasks only add small text files under a new `dogfood/` directory. They do not touch existing files.

## Task 1: Add the greeting file

Create `dogfood/hello.txt` containing exactly one line:

```text
Hello from the OpenHeimdall skills example.
```

Commit the file. Nothing else changes in this task.

Done when `dogfood/hello.txt` exists with exactly that line and the change is committed.

## Task 2: Add the output format file

Create `dogfood/format.txt` containing exactly one word: the output format the project owner wants for future reports. The permitted words are `plain` and `json`.

The repository does not say which format is wanted, and either word is equally valid, so you must not pick one yourself, infer one or use a default. Before creating any file in this task, stop and report that you cannot continue without an answer from the owner. In the report, name the two permitted words and ask which one to use. Create no file and make no commit until the owner has answered.

When the owner has answered, create `dogfood/format.txt` with exactly that word and one trailing newline, and commit it.

Done when `dogfood/format.txt` contains exactly the word the owner chose and the change is committed.
