import graphify
import inspect
for name in ['extract','cache','analyze','cluster','benchmark','export']:
    print('\nMODULE', name)
    try:
        mod = getattr(graphify, name)
        print('  hasattr', hasattr(graphify, name))
        print('  type', type(mod))
        if hasattr(mod, '__all__'):
            print('  __all__', mod.__all__)
        else:
            print('  attrs sample', [a for a in dir(mod) if a in ('build','to_nx','graph_from_dict','cluster','analyze','benchmark','to_html','to_obsidian') or a.startswith('to_')][:30])
    except Exception as e:
        print('  ERROR', e)
