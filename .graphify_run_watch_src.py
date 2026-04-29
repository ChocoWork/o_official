from pathlib import Path
import graphify.watch as watch

watch_path = Path('src')
print(f'Starting graphify watcher for {watch_path.resolve()}')
watch.watch(watch_path)
