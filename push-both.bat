@echo off
echo Pushing to GitHub...
git push github main

echo Pushing to Hugging Face...
git push hf main

echo Done! Both repositories updated.
