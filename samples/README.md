# Question paper format

What the **Exams → Upload a question paper** screen can read, and how to write
a paper it will read correctly.

Files: **.docx**, **.pdf** or **.txt**. Old `.doc` files are not supported —
open in Word and use *Save As → Word Document (.docx)*.

Start from [question-paper-sample.docx](question-paper-sample.docx) — open it in
Word, replace the questions, keep the layout.

## The three rules

**1. Number every question.** `1.` `2.` `3.` down the page. `Q1.` `1)` and
`1:` also work. The numbers must run in order — a jump from 3 to 7 makes the
parser treat the line as ordinary text.

**2. Put each option on its own line**, starting with a letter:

```
A) Venus
B) Mars
```

`A.` `(A)` and `a)` work too. Two or more options make it multiple choice; none
makes it fill-in-the-blank.

**3. Write the answer under the question.**

```
Answer: B
```

`Ans:`, `Key:` and `Correct answer:` all work. For multiple choice give the
letter. For fill-in-the-blank give the word.

## Fill in the blank

```
1. The capital city of India is ____.
Answer: New Delhi
```

Several acceptable answers, separated by `|`:

```
3. Water freezes at ____ degrees Celsius.
Answer: 0 | zero
```

A student typing either is marked correct. Case, extra spaces and a trailing
full stop are ignored when marking.

## Multiple choice

```
2. Which planet is known as the Red Planet?
A) Venus
B) Mars
C) Jupiter
D) Saturn
Answer: B
```

Up to eight options, A–H. `Answer: Mars` also works — the option text is matched
against the list.

## What is ignored

A title, batch name or date at the top is skipped automatically, as long as it
does not start with a number and a full stop.

## After uploading

The review screen shows every question it found, with a warning against
anything it was unsure about — a missing answer, or an answer that is not one of
the options. Fix them there before saving; nothing reaches the students until
you press Save.

**Marks are set to 1 per question on upload.** Change them on the review screen
if a question is worth more.

## If it goes wrong

| What you see | Usually means |
|---|---|
| "No questions could be recognised" | The numbering is missing, or the PDF is a scan (a photo of a page has no text in it — retype it, or use a Word file) |
| Two questions merged into one | A number was skipped, or a question is numbered out of order |
| Options read as question text | The option letter is missing its bracket or dot — `A) red`, not `A red` |
| "has no answer" | No `Answer:` line under that question |
